/** @format */

"use strict";

/**
 * Guarded v2 materialization for the single audited Expedia reservation.
 *
 * This script never calls Expedia, HotelRunner, or an exchange-rate service. It
 * accepts only a newly collected, explicit, supervised read-only Expedia job
 * whose stored conversion evidence is trusted, verified, hash-backed, fresh,
 * and internally reconciled. The v1 source-only manifest and backup set are
 * prerequisites and are never modified.
 *
 * Dry run:
 *   node scripts/repairExpediaCommercialMaterialization20260809.js
 *     --release-sha=<exact-merged-sha>
 *     --portal-job-id=<fresh-job-object-id>
 *     --portal-job-number=<fresh-job-number>
 *
 * Apply / rollback use the proof emitted by the immediately preceding dry run
 * and require --repair-id=expedia-commercial-materialization-20260809-v2.
 */

const crypto = require("node:crypto");
const path = require("node:path");

const { ObjectId } = require("bson");
const mongoose = require("mongoose");

require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);

const v1 = require("./repairExpediaCommercialEnrichment20260809");
const {
	buildExactCasFilter,
	canonicalEjsonSha256,
	cloneBson,
} = require("../services/recentOtaInboundRecovery20260805");
const {
	buildAuthenticatedProviderCommercialEvidence,
	validateOtaCommercialEvidence,
} = require("../services/otaCommercialEvidence");

const REPAIR_ID = "expedia-commercial-materialization-20260809-v2";
const BACKUP_COLLECTION = "ota_expedia_commercial_repair_backup_20260809_v2";
const MANIFEST_COLLECTION = v1.MANIFEST_COLLECTION;
const PROOF_MAX_AGE_MS = 30 * 60 * 1000;
const COLLECTOR_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CONVERSION_SOURCE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CONVERSION_SOURCE_FUTURE_SKEW_MS = 5 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 1000;
const TARGET = v1.TARGET;
const COLLECTIONS = v1.COLLECTIONS;

const clean = (value = "") => String(value?._id || value || "").trim();
const lower = (value = "") => clean(value).toLowerCase();
const upper = (value = "") => clean(value).toUpperCase();
const round2 = (value) => Number(Number(value).toFixed(2));
const sameMoney = (left, right) =>
	Number.isFinite(Number(left)) &&
	Number.isFinite(Number(right)) &&
	Math.abs(round2(left) - round2(right)) < 0.005;
const sameRate = (left, right) =>
	Number.isFinite(Number(left)) &&
	Number.isFinite(Number(right)) &&
	Math.abs(Number(left) - Number(right)) <= 0.0000000001;
const dateKey = (value) => {
	const parsed = value instanceof Date ? value : new Date(value);
	return Number.isFinite(parsed.getTime())
		? parsed.toISOString().slice(0, 10)
		: "";
};
const sha256 = (value) =>
	crypto
		.createHash("sha256")
		.update(String(value || ""), "utf8")
		.digest("hex");

function fail(message, code = "EXPEDIA_V2_REPAIR_BLOCKED") {
	const error = new Error(message);
	error.code = code;
	throw error;
}

function objectId(value, label = "Mongo id") {
	const textValue = clean(value);
	if (!ObjectId.isValid(textValue)) {
		fail(label + " is invalid.", "EXPEDIA_V2_REPAIR_ID_INVALID");
	}
	return new ObjectId(textValue);
}

function exactDate(value, label) {
	const parsed =
		value instanceof Date ? new Date(value) : new Date(value || "");
	if (!Number.isFinite(parsed.getTime())) {
		fail(label + " is missing or invalid.", "EXPEDIA_V2_EVIDENCE_TIME_INVALID");
	}
	return parsed;
}

function parseArguments(argv = []) {
	let apply = false;
	let rollback = false;
	let repairId = "";
	let releaseSha = "";
	let proof = "";
	let portalJobId = "";
	let portalJobNumber = "";
	for (const raw of argv) {
		const argument = clean(raw);
		if (argument === "--apply") {
			if (apply)
				fail(
					"--apply may be supplied only once.",
					"EXPEDIA_V2_ARGUMENT_INVALID"
				);
			apply = true;
			continue;
		}
		if (argument === "--rollback") {
			if (rollback) {
				fail(
					"--rollback may be supplied only once.",
					"EXPEDIA_V2_ARGUMENT_INVALID"
				);
			}
			rollback = true;
			continue;
		}
		let recognized = false;
		const entries = [
			["--repair-id=", repairId, (value) => (repairId = value)],
			["--release-sha=", releaseSha, (value) => (releaseSha = lower(value))],
			["--proof=", proof, (value) => (proof = lower(value))],
			[
				"--portal-job-id=",
				portalJobId,
				(value) => (portalJobId = lower(value)),
			],
			[
				"--portal-job-number=",
				portalJobNumber,
				(value) => (portalJobNumber = upper(value)),
			],
		];
		for (const [prefix, prior, assign] of entries) {
			if (!argument.startsWith(prefix)) continue;
			if (prior) {
				fail(
					prefix.slice(0, -1) + " may be supplied only once.",
					"EXPEDIA_V2_ARGUMENT_INVALID"
				);
			}
			assign(argument.slice(prefix.length));
			recognized = true;
			break;
		}
		if (!recognized) {
			fail(
				"Unsupported Expedia v2 repair argument.",
				"EXPEDIA_V2_ARGUMENT_INVALID"
			);
		}
	}
	if (!/^[a-f0-9]{40}$/.test(releaseSha)) {
		fail(
			"An exact 40-character --release-sha is required.",
			"EXPEDIA_V2_RELEASE_REQUIRED"
		);
	}
	if (!portalJobId || !portalJobNumber) {
		fail(
			"The fresh portal evidence requires both exact job selectors.",
			"EXPEDIA_V2_PORTAL_SELECTION_REQUIRED"
		);
	}
	if (!/^[a-f0-9]{24}$/.test(portalJobId)) {
		fail(
			"--portal-job-id must be an exact Mongo ObjectId.",
			"EXPEDIA_V2_PORTAL_SELECTION_INVALID"
		);
	}
	if (!/^OTA-RES-SYNC-\d{14}-[A-Z0-9]{5}$/.test(portalJobNumber)) {
		fail(
			"--portal-job-number must be an exact OTA reservation sync job number.",
			"EXPEDIA_V2_PORTAL_SELECTION_INVALID"
		);
	}
	if (apply && repairId !== REPAIR_ID) {
		fail(
			"Apply requires the exact v2 repair ID.",
			"EXPEDIA_V2_REPAIR_ID_REQUIRED"
		);
	}
	if (rollback && repairId !== REPAIR_ID) {
		fail(
			"Rollback requires the exact v2 repair ID.",
			"EXPEDIA_V2_REPAIR_ID_REQUIRED"
		);
	}
	if (!apply && !rollback && (repairId || proof)) {
		fail(
			"--repair-id and --proof are apply-only.",
			"EXPEDIA_V2_ARGUMENT_INVALID"
		);
	}
	if (apply && !/^\d{13}\.[a-f0-9]{64}$/.test(proof)) {
		fail(
			"Apply requires the exact unexpired dry-run proof.",
			"EXPEDIA_V2_PROOF_REQUIRED"
		);
	}
	if (!apply && proof) {
		fail(
			"--proof is accepted only with --apply.",
			"EXPEDIA_V2_ARGUMENT_INVALID"
		);
	}
	return {
		apply,
		rollback,
		repairId,
		releaseSha,
		proof,
		portalJobId,
		portalJobNumber,
	};
}

function portalSelectionFromArguments(options = {}) {
	return Object.freeze({
		jobId: lower(options.portalJobId),
		jobNumber: upper(options.portalJobNumber),
	});
}

function parseProof(proof, now = new Date()) {
	const match = lower(proof).match(/^(\d{13})\.([a-f0-9]{64})$/);
	if (!match)
		fail("The dry-run proof format is invalid.", "EXPEDIA_V2_PROOF_INVALID");
	const plannedAtMs = Number(match[1]);
	const nowMs = now.getTime();
	if (
		!Number.isSafeInteger(plannedAtMs) ||
		plannedAtMs > nowMs + CLOCK_SKEW_MS ||
		nowMs - plannedAtMs > PROOF_MAX_AGE_MS
	) {
		fail(
			"The dry-run proof is expired or from the future.",
			"EXPEDIA_V2_PROOF_EXPIRED"
		);
	}
	return { plannedAt: new Date(plannedAtMs), planHash: match[2] };
}

function proofToken(plan) {
	return new Date(plan.plannedAt).getTime() + "." + plan.planHash;
}

function rollbackProofToken(plan) {
	return proofToken(plan);
}

const primaryReadOptions = () => ({
	readPreference: "primary",
	readConcern: { level: "majority" },
});
const majorityWriteOptions = () => ({ writeConcern: { w: "majority" } });

async function findMany(collection, filter, limit = 3) {
	return collection.find(filter, primaryReadOptions()).limit(limit).toArray();
}

function reservationProviderLookup() {
	return {
		hotelId: objectId(TARGET.hotelId),
		$or: [
			{ reservation_id: TARGET.otaBookingId },
			{ "customer_details.confirmation_number2": TARGET.otaBookingId },
			{ otaIdentityKey: TARGET.otaIdentityKey },
			{ otaCrossTransportIdentityKey: TARGET.otaIdentityKey },
			{ "supplierData.otaConfirmationNumber": TARGET.otaBookingId },
			{ "supplierData.platformConfirmationNumber": TARGET.otaBookingId },
			{ "supplierData.hotelRunner.providerNumber": TARGET.otaBookingId },
		],
	};
}

function portalCandidate(job) {
	const matches = (
		Array.isArray(job?.previewBuckets?.matchedExisting)
			? job.previewBuckets.matchedExisting
			: []
	).filter(
		(candidate) =>
			clean(candidate?.confirmationNumber) === TARGET.otaBookingId ||
			clean(candidate?.matchedLookupValue) === TARGET.otaBookingId
	);
	if (matches.length !== 1) {
		fail(
			"The selected preview must contain exactly one target matched-existing row.",
			"EXPEDIA_V2_PORTAL_SCOPE_INVALID"
		);
	}
	return matches[0];
}

function assertPortalEnvelope(job, portalSelection) {
	const allowedFrom = new Set([TARGET.portalDateFrom, TARGET.checkinDate]);
	const allowedTo = new Set([TARGET.checkoutDate, TARGET.portalDateTo]);
	if (
		clean(job?._id) !== portalSelection.jobId ||
		upper(job?.jobNumber) !== portalSelection.jobNumber ||
		lower(job?.provider) !== "expedia" ||
		lower(job?.operation) !== "reservation_sync_preview" ||
		lower(job?.executionMode) !== "supervised_read_only" ||
		lower(job?.status) !== "preview_ready" ||
		lower(job?.collectorState?.status) !== "preview_ready" ||
		job?.collectorState?.readOnly !== true ||
		Number(job?.hotelCount) !== 1 ||
		!allowedFrom.has(clean(job?.dateFrom)) ||
		!allowedTo.has(clean(job?.dateTo)) ||
		Number(job?.resultSummary?.appliedWrites || 0) !== 0
	) {
		fail(
			"The supervised read-only Expedia job boundary is invalid.",
			"EXPEDIA_V2_PORTAL_SCOPE_INVALID"
		);
	}
	const targetHotels = Array.isArray(job?.targetHotels) ? job.targetHotels : [];
	const selectedIds = Array.isArray(job?.collectorState?.selectedHotelIds)
		? job.collectorState.selectedHotelIds.map(clean)
		: [];
	if (
		targetHotels.length !== 1 ||
		clean(targetHotels[0]?.hotelId) !== TARGET.hotelId ||
		selectedIds.length !== 1 ||
		selectedIds[0] !== TARGET.hotelId ||
		Number(job?.collectorState?.selectedHotelCount) !== 1
	) {
		fail(
			"The preview job is not confined to the one audited hotel.",
			"EXPEDIA_V2_PORTAL_SCOPE_INVALID"
		);
	}
	const finished = (Array.isArray(job?.auditLog) ? job.auditLog : []).filter(
		(entry) =>
			clean(entry?.action) === "collector_finished" && entry?.readOnly === true
	);
	if (finished.length !== 1) {
		fail(
			"The preview job lacks one exact read-only completion audit.",
			"EXPEDIA_V2_PORTAL_SCOPE_INVALID"
		);
	}
	return { candidate: portalCandidate(job), finishedAudit: finished[0] };
}

function assertTrustedConversion(value = {}) {
	const provenance = value?.provenance || {};
	const sourceHash = lower(provenance.sourceHash);
	const sourceId = lower(provenance.sourceId);
	const rate = Number(value?.rate);
	const sourceTimestamp = exactDate(
		provenance.sourceTimestamp,
		"conversion provenance timestamp"
	);
	const normalizedRate = Number(rate.toFixed(10));
	const expectedTuple = {
		provider: "exchange_rate_api",
		sourceType: "trusted_exchange_evidence",
		sourceCurrency: TARGET.sourceCurrency,
		propertyCurrency: TARGET.propertyCurrency,
		rate: normalizedRate,
		sourceTimestamp: sourceTimestamp.toISOString(),
	};
	const expectedHash = sha256(JSON.stringify(expectedTuple));
	const expectedId = "exchange-rate-api-usd-sar-" + expectedHash.slice(0, 24);
	if (
		value?.trusted !== true ||
		value?.verified !== true ||
		upper(value?.sourceCurrency) !== TARGET.sourceCurrency ||
		upper(value?.propertyCurrency) !== TARGET.propertyCurrency ||
		!Number.isFinite(rate) ||
		rate <= 0 ||
		rate > 1_000_000 ||
		lower(provenance.provider) !== "exchange_rate_api" ||
		lower(provenance.sourceType) !== "trusted_exchange_evidence" ||
		sourceHash !== expectedHash ||
		sourceId !== expectedId
	) {
		fail(
			"The stored currency conversion evidence is not the trusted exact contract.",
			"EXPEDIA_V2_CONVERSION_UNTRUSTED"
		);
	}
	return {
		trusted: true,
		verified: true,
		sourceCurrency: TARGET.sourceCurrency,
		propertyCurrency: TARGET.propertyCurrency,
		rate: normalizedRate,
		provenance: {
			provider: "exchange_rate_api",
			sourceType: "trusted_exchange_evidence",
			sourceHash,
			sourceTimestamp: sourceTimestamp.toISOString(),
			sourceId,
		},
	};
}

function assertFreshPortalEvidence({
	job,
	portalSelection,
	lineage,
	plannedAt,
	requireFresh = true,
}) {
	const { candidate, finishedAudit } = assertPortalEnvelope(
		job,
		portalSelection
	);
	const summary = candidate?.paymentSummary || {};
	const conversion = assertTrustedConversion(
		candidate?.currencyConversionEvidence
	);
	const gross = round2(TARGET.portalGuestGross * conversion.rate);
	const payout = round2(TARGET.hotelRunnerReportedAmount * conversion.rate);
	const createdAt = exactDate(job?.createdAt, "collector creation timestamp");
	const finishedAt = exactDate(
		job?.collectorState?.finishedAt || job?.updatedAt,
		"collector completion timestamp"
	);
	const auditAt = exactDate(
		finishedAudit?.at,
		"collector completion audit timestamp"
	);
	const conversionSourceAt = exactDate(
		conversion.provenance.sourceTimestamp,
		"conversion source timestamp"
	);
	const conversionFetchedAt = exactDate(
		candidate?.amountConvertedAt,
		"candidate conversion fetch timestamp"
	);
	const summaryConversionFetchedAt = exactDate(
		summary?.amountConvertedAt,
		"summary conversion fetch timestamp"
	);
	const v1AppliedAt = exactDate(
		lineage?.manifest?.appliedAt,
		"v1 applied timestamp"
	);
	const planTime = exactDate(plannedAt, "repair plan timestamp");
	if (
		clean(candidate?.hotelId) !== TARGET.hotelId ||
		clean(candidate?.confirmationNumber) !== TARGET.otaBookingId ||
		clean(candidate?.reservationId) !== TARGET.reservationMongoId ||
		clean(candidate?.pmsConfirmationNumber) !== TARGET.pmsConfirmationNumber ||
		clean(candidate?.matchedLookupValue) !== TARGET.otaBookingId ||
		clean(candidate?.actionPreview) !== "matched_existing_no_write" ||
		dateKey(candidate?.checkinDate) !== TARGET.checkinDate ||
		dateKey(candidate?.checkoutDate) !== TARGET.checkoutDate ||
		lower(candidate?.paymentCollectionModel) !== "expedia_collect" ||
		candidate?.detailsFetched !== true ||
		candidate?.requiresManualReview === true ||
		candidate?.commercialEvidenceConflict === true ||
		(Array.isArray(candidate?.commercialEvidenceConflicts) &&
			candidate.commercialEvidenceConflicts.length > 0) ||
		clean(candidate?.fxConversionError) ||
		upper(candidate?.sourceCurrency) !== TARGET.sourceCurrency ||
		upper(summary?.sourceCurrency) !== TARGET.sourceCurrency ||
		!sameMoney(candidate?.sourceAmount, TARGET.portalGuestGross) ||
		!sameMoney(
			summary?.sourceTotalGuestPaymentAmount,
			TARGET.portalGuestGross
		) ||
		!sameMoney(
			summary?.sourceTotalPayoutAmount,
			TARGET.hotelRunnerReportedAmount
		) ||
		!sameMoney(
			candidate?.sourcePayoutAmount,
			TARGET.hotelRunnerReportedAmount
		) ||
		upper(candidate?.sourcePayoutCurrency) !== TARGET.sourceCurrency ||
		upper(summary?.sourceTotalPayoutCurrency) !== TARGET.sourceCurrency ||
		candidate?.propertyConversionVerified !== true ||
		summary?.propertyConversionVerified !== true ||
		upper(candidate?.propertyCurrency) !== TARGET.propertyCurrency ||
		upper(summary?.propertyCurrency) !== TARGET.propertyCurrency ||
		upper(candidate?.currency) !== TARGET.propertyCurrency ||
		upper(summary?.currency) !== TARGET.propertyCurrency ||
		!sameMoney(candidate?.totalAmountSar, gross) ||
		!sameMoney(candidate?.amount, gross) ||
		!sameMoney(summary?.totalGuestPaymentAmount, gross) ||
		!sameMoney(summary?.totalPayoutAmount, payout) ||
		!sameMoney(candidate?.totalPayoutSar, payout) ||
		!sameMoney(candidate?.netAfterExpensesTotal, payout) ||
		!sameRate(candidate?.exchangeRateToSar, conversion.rate) ||
		!sameRate(summary?.exchangeRateToSar, conversion.rate) ||
		![
			"exchange_rate_api",
			"exchange_rate_api_cached",
			"exchange_rate_api_stored",
		].includes(lower(candidate?.exchangeRateSource)) ||
		![
			"exchange_rate_api",
			"exchange_rate_api_cached",
			"exchange_rate_api_stored",
		].includes(lower(summary?.exchangeRateSource))
	) {
		fail(
			"The portal row does not reconcile the exact authenticated USD gross and payout.",
			"EXPEDIA_V2_PORTAL_MONEY_INVALID"
		);
	}
	if (conversionFetchedAt.getTime() !== summaryConversionFetchedAt.getTime()) {
		fail(
			"The materialized portal amounts do not share one conversion fetch.",
			"EXPEDIA_V2_CONVERSION_UNTRUSTED"
		);
	}
	for (const value of [
		candidate?.explicitOtaCommission,
		summary?.explicitOtaCommission,
	]) {
		if (value != null && Number(value) !== 0) {
			fail(
				"An explicit OTA commission appeared and requires a new plan.",
				"EXPEDIA_V2_COMMISSION_CONFLICT"
			);
		}
	}
	if (
		finishedAt.getTime() < createdAt.getTime() ||
		auditAt.getTime() < finishedAt.getTime() ||
		auditAt.getTime() > finishedAt.getTime() + CLOCK_SKEW_MS ||
		createdAt.getTime() - conversionFetchedAt.getTime() >
			COLLECTOR_MAX_AGE_MS ||
		conversionFetchedAt.getTime() > finishedAt.getTime() + CLOCK_SKEW_MS ||
		conversionSourceAt.getTime() >
			conversionFetchedAt.getTime() + CONVERSION_SOURCE_FUTURE_SKEW_MS ||
		conversionFetchedAt.getTime() - conversionSourceAt.getTime() >
			CONVERSION_SOURCE_MAX_AGE_MS
	) {
		fail(
			"The portal or conversion evidence chronology is invalid.",
			"EXPEDIA_V2_EVIDENCE_TIME_INVALID"
		);
	}
	if (
		requireFresh &&
		(createdAt.getTime() <= v1AppliedAt.getTime() ||
			portalSelection.jobId === clean(lineage?.manifest?.portalJobId) ||
			finishedAt.getTime() > planTime.getTime() + CLOCK_SKEW_MS ||
			planTime.getTime() - finishedAt.getTime() > COLLECTOR_MAX_AGE_MS ||
			planTime.getTime() - conversionFetchedAt.getTime() > COLLECTOR_MAX_AGE_MS)
	) {
		fail(
			"The selected collector evidence is not fresh after v1.",
			"EXPEDIA_V2_EVIDENCE_STALE"
		);
	}
	return {
		candidate,
		conversion,
		gross,
		payout,
		deduction: round2(gross - payout),
		sourceDeduction: round2(
			TARGET.portalGuestGross - TARGET.hotelRunnerReportedAmount
		),
		sourceTimestamp: finishedAt,
		conversionFetchedAt,
	};
}

async function loadV1Lineage(db) {
	const manifest = await db
		.collection(v1.MANIFEST_COLLECTION)
		.findOne({ _id: v1.REPAIR_ID }, primaryReadOptions());
	if (
		!manifest ||
		clean(manifest.repairId) !== v1.REPAIR_ID ||
		manifest.state !== "applied" ||
		manifest.backupCollection !== v1.BACKUP_COLLECTION ||
		Number(manifest.backupRecordCount) !== 4 ||
		!/^[a-f0-9]{40}$/.test(lower(manifest.releaseSha)) ||
		!/^[a-f0-9]{64}$/.test(lower(manifest.planHash)) ||
		!/^[a-f0-9]{64}$/.test(lower(manifest.originalHash)) ||
		!/^[a-f0-9]{64}$/.test(lower(manifest.expectedRepairedHash)) ||
		!/^[a-f0-9]{64}$/.test(lower(manifest.evidenceHash)) ||
		!/^[a-f0-9]{64}$/.test(lower(manifest.backupSetSha256)) ||
		manifest.appliedDocumentHash !== manifest.expectedRepairedHash ||
		Number(manifest.vendorApiCalls || 0) !== 0
	) {
		fail(
			"The immutable v1 repair is not in its exact applied state.",
			"EXPEDIA_V2_V1_LINEAGE_INVALID"
		);
	}
	const predecessorSelection = {
		jobId: clean(manifest.portalJobId),
		jobNumber: clean(manifest.portalJobNumber),
	};
	const backup = await v1.loadAndVerifyBackup(db, predecessorSelection);
	const reservationRecord = backup.byRole.get("reservation_before");
	const eventRecord = backup.byRole.get("hotelrunner_event_evidence");
	const mirrorRecord = backup.byRole.get("hotelrunner_mirror_evidence");
	const portalRecord = backup.byRole.get("expedia_portal_job_evidence");
	if (
		!reservationRecord ||
		!eventRecord ||
		!mirrorRecord ||
		!portalRecord ||
		reservationRecord.sourceCollection !== COLLECTIONS.reservation ||
		eventRecord.sourceCollection !== COLLECTIONS.event ||
		mirrorRecord.sourceCollection !== COLLECTIONS.mirror ||
		portalRecord.sourceCollection !== COLLECTIONS.portalJob ||
		clean(reservationRecord.documentId) !== TARGET.reservationMongoId ||
		clean(eventRecord.documentId) !== TARGET.eventId ||
		clean(mirrorRecord.documentId) !== TARGET.mirrorId ||
		reservationRecord.expectedRepairedHash !== manifest.expectedRepairedHash ||
		reservationRecord.originalHash !== manifest.originalHash ||
		backup.backupSetSha256 !== manifest.backupSetSha256
	) {
		fail(
			"The v1 manifest and immutable backup lineage diverged.",
			"EXPEDIA_V2_V1_LINEAGE_INVALID"
		);
	}
	v1.assertPreRepairCommercialState(reservationRecord.originalDocument);
	v1.assertHotelRunnerEnvelope(
		eventRecord.originalDocument,
		mirrorRecord.originalDocument
	);
	v1.assertPortalJob(portalRecord.originalDocument, predecessorSelection);
	const [liveEvent, liveMirror, livePortalJob] = await Promise.all([
		db
			.collection(COLLECTIONS.event)
			.findOne({ _id: objectId(TARGET.eventId) }, primaryReadOptions()),
		db
			.collection(COLLECTIONS.mirror)
			.findOne({ _id: objectId(TARGET.mirrorId) }, primaryReadOptions()),
		db
			.collection(COLLECTIONS.portalJob)
			.findOne(
				{ _id: objectId(predecessorSelection.jobId) },
				primaryReadOptions()
			),
	]);
	if (
		!liveEvent ||
		!liveMirror ||
		!livePortalJob ||
		canonicalEjsonSha256(liveEvent) !== eventRecord.originalHash ||
		canonicalEjsonSha256(liveMirror) !== mirrorRecord.originalHash ||
		canonicalEjsonSha256(livePortalJob) !== portalRecord.originalHash
	) {
		fail(
			"Live v1 evidence no longer equals its immutable archive.",
			"EXPEDIA_V2_V1_LINEAGE_INVALID"
		);
	}
	const rebuilt = v1.buildExpectedDocument({
		reservation: reservationRecord.originalDocument,
		event: eventRecord.originalDocument,
		job: portalRecord.originalDocument,
		releaseSha: manifest.releaseSha,
		repairAt: manifest.proofPlannedAt,
		portalSelection: predecessorSelection,
	});
	if (
		canonicalEjsonSha256(rebuilt.expectedDocument) !==
			manifest.expectedRepairedHash ||
		rebuilt.evidence.evidenceHash !== manifest.evidenceHash
	) {
		fail(
			"The v1 post-state cannot be reconstructed from its immutable proof.",
			"EXPEDIA_V2_V1_LINEAGE_INVALID"
		);
	}
	return {
		manifest,
		manifestHash: canonicalEjsonSha256(manifest),
		backup,
		expectedDocument: rebuilt.expectedDocument,
		expectedHash: manifest.expectedRepairedHash,
		predecessorSelection,
	};
}

async function loadRawScope(db, portalSelection) {
	const reservations = db.collection(COLLECTIONS.reservation);
	const [reservation, pmsMatches, providerMatches, event, mirror, job] =
		await Promise.all([
			reservations.findOne(
				{ _id: objectId(TARGET.reservationMongoId) },
				primaryReadOptions()
			),
			findMany(
				reservations,
				{
					hotelId: objectId(TARGET.hotelId),
					confirmation_number: TARGET.pmsConfirmationNumber,
				},
				3
			),
			findMany(reservations, reservationProviderLookup(), 3),
			db
				.collection(COLLECTIONS.event)
				.findOne({ _id: objectId(TARGET.eventId) }, primaryReadOptions()),
			db
				.collection(COLLECTIONS.mirror)
				.findOne({ _id: objectId(TARGET.mirrorId) }, primaryReadOptions()),
			db
				.collection(COLLECTIONS.portalJob)
				.findOne(
					{ _id: objectId(portalSelection.jobId) },
					primaryReadOptions()
				),
		]);
	if (!reservation || pmsMatches.length !== 1 || providerMatches.length !== 1) {
		fail(
			"The exact reservation uniqueness boundary failed.",
			"EXPEDIA_V2_IDENTITY_INVALID"
		);
	}
	if (
		clean(pmsMatches[0]?._id) !== TARGET.reservationMongoId ||
		clean(providerMatches[0]?._id) !== TARGET.reservationMongoId
	) {
		fail(
			"PMS and provider identities do not converge.",
			"EXPEDIA_V2_IDENTITY_INVALID"
		);
	}
	v1.assertHotelRunnerEnvelope(event, mirror);
	assertPortalEnvelope(job, portalSelection);
	return { reservation, event, mirror, job };
}

function assertPredecessorLiveEvidence(scope, lineage) {
	const eventRecord = lineage.backup.byRole.get("hotelrunner_event_evidence");
	const mirrorRecord = lineage.backup.byRole.get("hotelrunner_mirror_evidence");
	if (
		canonicalEjsonSha256(scope.event) !== eventRecord.originalHash ||
		canonicalEjsonSha256(scope.mirror) !== mirrorRecord.originalHash
	) {
		fail(
			"Live HotelRunner evidence no longer equals the immutable v1 archive.",
			"EXPEDIA_V2_V1_LINEAGE_INVALID"
		);
	}
}

function assertOperationallySafe(reservation, expectedV1Document) {
	const state = lower(reservation?.state);
	const reservationStatus = lower(reservation?.reservation_status);
	const terminal =
		/cancel|no.?show|inhouse|in.house|housed|check.?in|check.?out|complete/;
	if (
		terminal.test(state) ||
		terminal.test(reservationStatus) ||
		state !== lower(expectedV1Document?.state) ||
		reservationStatus !== lower(expectedV1Document?.reservation_status)
	) {
		fail("Lifecycle changed or is terminal.", "EXPEDIA_V2_PROTECTED_STATE");
	}
	const meaningful = (value) => {
		if (value == null || value === false || value === 0 || value === "")
			return false;
		if (Array.isArray(value)) return value.length > 0;
		if (typeof value === "object") return Object.keys(value).length > 0;
		return true;
	};
	if (
		meaningful(reservation?.roomId) ||
		meaningful(reservation?.bedNumber) ||
		[
			reservation?.housed,
			reservation?.isHoused,
			reservation?.housedAt,
			reservation?.housedBy,
			reservation?.checkedInAt,
			reservation?.checkedOutAt,
		].some(meaningful)
	) {
		fail(
			"Housing or room assignment activity blocks repair.",
			"EXPEDIA_V2_PROTECTED_STATE"
		);
	}
	if (
		Math.abs(Number(reservation?.paid_amount || 0)) > 0.0001 ||
		reservation?.moneyTransferredToHotel === true ||
		reservation?.commissionPaid === true ||
		reservation?.payment_details?.captured === true ||
		Math.abs(Number(reservation?.payment_details?.onsite_paid_amount || 0)) >
			0.0001 ||
		[
			reservation?.payment_details?.captureId,
			reservation?.payment_details?.transactionId,
			reservation?.payment_details?.settlementId,
			reservation?.financial_cycle?.capturedAt,
			reservation?.financial_cycle?.settledAt,
			reservation?.financial_cycle?.paidAt,
			reservation?.financial_cycle?.hotelPaidAt,
			reservation?.financial_cycle?.captureId,
			reservation?.financial_cycle?.settlementId,
			reservation?.bofa_payment?.vcc?.chargedAt,
			reservation?.bofa_payment?.vcc?.captureId,
			reservation?.bofa_payment?.vcc?.transactionId,
		].some(meaningful) ||
		["paid", "captured", "settled", "complete", "completed"].includes(
			lower(reservation?.financial_cycle?.status)
		) ||
		reservation?.bofa_payment?.vcc?.charged === true ||
		!/^(|not paid|unpaid|pending)$/i.test(clean(reservation?.financeStatus))
	) {
		fail(
			"Capture or settlement activity blocks repair.",
			"EXPEDIA_V2_PROTECTED_STATE"
		);
	}
	const review = reservation?.otaPlatformReview || {};
	const admin = reservation?.adminPricing || {};
	if (
		meaningful(reservation?.orderTakeId) ||
		meaningful(reservation?.adminChangeLog) ||
		meaningful(reservation?.financeRejectionComment) ||
		meaningful(reservation?.totalReviewStatus) ||
		[
			review.releasedAt,
			review.releasedBy,
			review.closedAt,
			review.closedBy,
			review.lastPricingUpdatedAt,
			review.pricingInvalidatedAt,
			reservation?.adminPricingVisibility?.appliedBy,
		].some(meaningful) ||
		["released", "closed", "approved", "rejected"].includes(
			lower(review.status)
		) ||
		/manual|employee|admin/.test(
			(clean(admin.mode) + " " + clean(admin.source)).toLowerCase()
		) ||
		Object.keys(admin).some((key) =>
			key.toLowerCase().startsWith("clienttotaloverride")
		)
	) {
		fail(
			"Manual or released state blocks repair.",
			"EXPEDIA_V2_PROTECTED_STATE"
		);
	}
}

function assertExactV1PostState(reservation, lineage) {
	assertOperationallySafe(reservation, lineage.expectedDocument);
	if (
		canonicalEjsonSha256(reservation) !== lineage.expectedHash ||
		Number(reservation?.__v) !== TARGET.reservationVersion + 1 ||
		clean(reservation?.supplierData?.otaCommercialRepair?.repairId) !==
			v1.REPAIR_ID ||
		reservation?.total_amount !== null ||
		reservation?.adminPricing?.clientTotal !== null ||
		reservation?.adminPricing?.netAfterExpensesTotal !== null ||
		reservation?.ota_financial_summary?.clientTotal !== null ||
		reservation?.ota_financial_summary?.netAfterExpenses !== null ||
		reservation?.supplierData?.otaAmountSar !== null ||
		reservation?.supplierData?.otaTotalPayoutSar !== null ||
		reservation?.supplierData?.otaExpenseTotalSar !== null ||
		reservation?.supplierData?.otaCommercialEvidence?.currencyConversion !==
			null ||
		reservation?.supplierData?.otaCommercialEvidence?.roles?.guestGross
			?.propertyAmount !== null ||
		reservation?.supplierData?.otaCommercialEvidence?.roles?.hotelPayout
			?.propertyAmount !== null
	) {
		fail(
			"The reservation is not the exact immutable v1 source-only post-state.",
			"EXPEDIA_V2_V1_POST_STATE_INVALID"
		);
	}
}

function sourceSlots(reservation = {}) {
	const rooms = Array.isArray(reservation?.pickedRoomsPricing)
		? reservation.pickedRoomsPricing
		: [];
	const mirrored = Array.isArray(reservation?.pickedRoomsType)
		? reservation.pickedRoomsType
		: [];
	if (
		rooms.length !== 1 ||
		mirrored.length !== 1 ||
		canonicalEjsonSha256(rooms) !== canonicalEjsonSha256(mirrored)
	) {
		fail(
			"The two one-room pricing projections diverged.",
			"EXPEDIA_V2_ALLOCATION_INVALID"
		);
	}
	const days = Array.isArray(rooms[0]?.pricingByDay)
		? rooms[0].pricingByDay
		: [];
	const rawNights = (
		Array.isArray(reservation?.supplierData?.hotelRunner?.pricing?.rooms)
			? reservation.supplierData.hotelRunner.pricing.rooms
			: []
	).flatMap((room) => (Array.isArray(room?.nightly) ? room.nightly : []));
	if (days.length !== TARGET.nights || rawNights.length !== TARGET.nights) {
		fail(
			"The exact six-night source allocation boundary changed.",
			"EXPEDIA_V2_ALLOCATION_INVALID"
		);
	}
	const rawByDate = new Map();
	for (const row of rawNights) {
		const key = dateKey(row?.date);
		if (!key || rawByDate.has(key)) {
			fail(
				"HotelRunner source nights are missing or duplicated.",
				"EXPEDIA_V2_ALLOCATION_INVALID"
			);
		}
		rawByDate.set(key, Number(row?.finalPrice));
	}
	const slots = days.map((day, index) => {
		const expectedDate = new Date(TARGET.checkinDate + "T00:00:00.000Z");
		expectedDate.setUTCDate(expectedDate.getUTCDate() + index);
		const key = dateKey(day?.date);
		const sourceWeight = Number(day?.hotelRunnerSourcePrice);
		const rawWeight = rawByDate.get(key);
		const rootWeight = Number(day?.rootPrice);
		if (
			key !== expectedDate.toISOString().slice(0, 10) ||
			!Number.isFinite(sourceWeight) ||
			sourceWeight <= 0 ||
			!Number.isFinite(rawWeight) ||
			rawWeight <= 0 ||
			!sameMoney(sourceWeight, rawWeight) ||
			!Number.isFinite(rootWeight) ||
			rootWeight < 0 ||
			!sameMoney(rootWeight, TARGET.dailyRoot[index])
		) {
			fail(
				"A stored source/root allocation weight is invalid.",
				"EXPEDIA_V2_ALLOCATION_INVALID"
			);
		}
		return {
			roomIndex: 0,
			dayIndex: index,
			date: key,
			sourceWeight,
			rootWeight,
		};
	});
	if (
		!sameMoney(
			slots.reduce((sum, slot) => sum + slot.sourceWeight, 0),
			TARGET.hotelRunnerReportedAmount
		) ||
		!sameMoney(
			slots.reduce((sum, slot) => sum + slot.rootWeight, 0),
			TARGET.rootTotal
		)
	) {
		fail(
			"Stored source/root weights do not reconcile to exact totals.",
			"EXPEDIA_V2_ALLOCATION_INVALID"
		);
	}
	return slots;
}

function allocateCentsByWeight(totalAmount, weights = []) {
	const totalCents = Math.round(Number(totalAmount) * 100);
	const safeWeights = weights.map(Number);
	if (
		!Number.isSafeInteger(totalCents) ||
		totalCents < 0 ||
		!safeWeights.length ||
		safeWeights.some((weight) => !Number.isFinite(weight) || weight <= 0)
	) {
		fail(
			"Cent allocation requires positive stored weights.",
			"EXPEDIA_V2_ALLOCATION_INVALID"
		);
	}
	const weightTotal = safeWeights.reduce((sum, weight) => sum + weight, 0);
	const exact = safeWeights.map(
		(weight) => (totalCents * weight) / weightTotal
	);
	const cents = exact.map(Math.floor);
	let remainder = totalCents - cents.reduce((sum, value) => sum + value, 0);
	const order = exact
		.map((value, index) => ({ index, fraction: value - Math.floor(value) }))
		.sort(
			(left, right) =>
				right.fraction - left.fraction || left.index - right.index
		);
	for (let index = 0; remainder > 0; index += 1) {
		cents[order[index % order.length].index] += 1;
		remainder -= 1;
	}
	return cents.map((value) => value / 100);
}

function buildWeightedPricing(reservation, { gross, payout }) {
	const slots = sourceSlots(reservation);
	const weights = slots.map((slot) => slot.sourceWeight);
	const grossSlots = allocateCentsByWeight(gross, weights);
	const payoutSlots = allocateCentsByWeight(payout, weights);
	if (payoutSlots.some((value, index) => value > grossSlots[index] + 0.004)) {
		fail(
			"A nightly payout exceeds its gross allocation.",
			"EXPEDIA_V2_ALLOCATION_INVALID"
		);
	}
	const rooms = cloneBson(reservation.pickedRoomsPricing);
	for (const [index, slot] of slots.entries()) {
		const day = rooms[slot.roomIndex].pricingByDay[slot.dayIndex];
		const client = round2(grossSlots[index]);
		const net = round2(payoutSlots[index]);
		Object.assign(day, {
			price: client,
			clientPrice: client,
			mainPrice: client,
			totalPriceWithCommission: client,
			netAfterExpenses: net,
			netAfterOtaExpenses: net,
			otaExpenseAmount: round2(client - net),
			platformMargin: round2(net - slot.rootWeight),
			commercialVerification: "authenticated_provider_portal_verified",
			hotelRunnerSourcePrice: round2(slot.sourceWeight),
		});
	}
	for (const room of rooms) {
		room.totalPriceWithCommission = round2(
			room.pricingByDay.reduce((sum, day) => sum + Number(day.clientPrice), 0)
		);
		room.hotelShouldGet = round2(
			room.pricingByDay.reduce((sum, day) => sum + Number(day.rootPrice), 0)
		);
		room.chosenPrice = round2(
			room.totalPriceWithCommission / room.pricingByDay.length
		);
	}
	const sum = (field) =>
		round2(
			rooms
				.flatMap((room) => room.pricingByDay)
				.reduce((total, day) => total + Number(day[field]), 0)
		);
	if (
		!sameMoney(sum("clientPrice"), gross) ||
		!sameMoney(sum("netAfterExpenses"), payout) ||
		!sameMoney(sum("otaExpenseAmount"), round2(gross - payout)) ||
		!sameMoney(sum("platformMargin"), round2(payout - TARGET.rootTotal))
	) {
		fail(
			"The cent-exact room/day allocation does not reconcile.",
			"EXPEDIA_V2_ALLOCATION_INVALID"
		);
	}
	return rooms;
}

function rootEvidenceProjection(reservation = {}) {
	return {
		reservationHash: canonicalEjsonSha256(reservation),
		subTotal: reservation.sub_total,
		adminRootTotal: reservation.adminPricing?.rootTotal,
		hotelVisibleAmount: reservation.ota_financial_summary?.hotelVisibleAmount,
		rooms: (reservation.pickedRoomsPricing || []).map((room) => ({
			hotelRoomConfigId: clean(
				room?.hotelRoomConfigId || room?.localRoomConfigId
			),
			hotelShouldGet: room?.hotelShouldGet,
			count: room?.count,
			pricingByDay: (room?.pricingByDay || []).map((day) => ({
				date: dateKey(day?.date),
				rootPrice: day?.rootPrice,
				totalPriceWithoutCommission: day?.totalPriceWithoutCommission,
				hotelRunnerSourcePrice: day?.hotelRunnerSourcePrice,
			})),
		})),
	};
}

function buildCommercialEvidence({
	reservation,
	event,
	job,
	portalSelection,
	lineage,
	plannedAt,
}) {
	const portal = assertFreshPortalEvidence({
		job,
		portalSelection,
		lineage,
		plannedAt,
		requireFresh: true,
	});
	const sourceJobHash = canonicalEjsonSha256(job);
	const rootHash = canonicalEjsonSha256(rootEvidenceProjection(reservation));
	const eventTimestamp =
		event?.sourceUpdatedAt || event?.receivedAt || event?.createdAt;
	const hotelBaseTimestamp =
		reservation?.createdAt || eventTimestamp || portal.sourceTimestamp;
	const evidence = buildAuthenticatedProviderCommercialEvidence({
		provider: "expedia",
		authenticatedProvider: "expedia",
		sourceAuthenticated: true,
		sourceTrusted: true,
		sourceType: "authenticated_provider_portal",
		sourceCurrency: TARGET.sourceCurrency,
		propertyCurrency: TARGET.propertyCurrency,
		bookingBasis: "reservation_total",
		sourceHash: sourceJobHash,
		sourceTimestamp: portal.sourceTimestamp,
		sourceId: portalSelection.jobId,
		guestGross: {
			verified: true,
			amount: TARGET.portalGuestGross,
			currency: TARGET.sourceCurrency,
		},
		hotelPayout: {
			verified: true,
			amount: TARGET.hotelRunnerReportedAmount,
			currency: TARGET.sourceCurrency,
		},
		hotelBase: {
			verified: true,
			amount: TARGET.rootTotal,
			currency: TARGET.propertyCurrency,
			provenance: {
				provider: "jannat_pms",
				sourceType: "pms_root_pricing",
				sourceHash: rootHash,
				sourceTimestamp: hotelBaseTimestamp,
				sourceId: TARGET.reservationMongoId + ":root-pricing",
			},
		},
		hotelRunnerReportedAmount: {
			amount: TARGET.hotelRunnerReportedAmount,
			currency: TARGET.sourceCurrency,
			role: "hotel_payout",
			explicitRoleAssignment: true,
			provenance: {
				provider: "expedia",
				sourceType: "hotelrunner_webhook",
				sourceHash: TARGET.eventPayloadHash,
				sourceTimestamp: eventTimestamp,
				sourceId: TARGET.eventId,
			},
		},
		currencyConversion: portal.conversion,
	});
	const validation = validateOtaCommercialEvidence(evidence);
	const gross = evidence?.roles?.guestGross;
	const payout = evidence?.roles?.hotelPayout;
	const deduction = evidence?.roles?.deductionAggregate;
	if (
		!validation.ok ||
		evidence.verificationState !== "verified" ||
		evidence?.currencyConversion?.verified !== true ||
		!sameRate(evidence?.currencyConversion?.rate, portal.conversion.rate) ||
		!sameMoney(gross?.sourceAmount, TARGET.portalGuestGross) ||
		!sameMoney(gross?.propertyAmount, portal.gross) ||
		!sameMoney(payout?.sourceAmount, TARGET.hotelRunnerReportedAmount) ||
		!sameMoney(payout?.propertyAmount, portal.payout) ||
		!sameMoney(deduction?.sourceAmount, portal.sourceDeduction) ||
		!sameMoney(deduction?.propertyAmount, portal.deduction) ||
		evidence?.roles?.explicitOtaCommission?.verified !== false ||
		evidence?.roles?.explicitOtaCommission?.propertyAmount !== null
	) {
		fail(
			"The common commercial contract did not produce the exact verified roles.",
			"EXPEDIA_V2_CONTRACT_INVALID"
		);
	}
	return {
		...portal,
		evidence,
		sourceJobHash,
		rootHash,
		margin: round2(portal.payout - TARGET.rootTotal),
		conversionHash: canonicalEjsonSha256(portal.conversion),
	};
}

function optionalSourceMoney(value) {
	if (value === null || value === undefined || value === "") return null;
	const number = Number(value);
	if (!Number.isFinite(number) || number < 0) {
		fail(
			"An optional source payment amount is invalid.",
			"EXPEDIA_V2_PORTAL_MONEY_INVALID"
		);
	}
	return round2(number);
}

function materializedPaymentSummary(candidate, commercial, sourceJobHash) {
	const source = candidate?.paymentSummary || {};
	const convert = (value) => {
		const amount = optionalSourceMoney(value);
		return amount === null ? null : round2(amount * commercial.conversion.rate);
	};
	const fields = [
		["sourceNightlyRateAmount", "nightlyRateAmount"],
		["sourceTaxesAmount", "taxesAmount"],
		["sourceExpediaCompensationAmount", "expediaCompensationAmount"],
		["sourceAcceleratorAmount", "acceleratorAmount"],
	];
	const optional = {};
	for (const [sourceField, propertyField] of fields) {
		const sourceValue = optionalSourceMoney(source[sourceField]);
		const propertyValue = convert(source[sourceField]);
		if (
			source[propertyField] !== null &&
			source[propertyField] !== undefined &&
			!sameMoney(source[propertyField], propertyValue)
		) {
			fail(
				"A payment breakdown does not reconcile to trusted conversion.",
				"EXPEDIA_V2_PORTAL_MONEY_INVALID"
			);
		}
		optional[sourceField] = sourceValue;
		optional[propertyField] = propertyValue;
	}
	return {
		sourceType: "authenticated_provider_portal",
		sourceJobHash,
		paymentCollectionModel: "ota_collect",
		sourceCurrency: TARGET.sourceCurrency,
		propertyCurrency: TARGET.propertyCurrency,
		sourceTotalGuestPaymentAmount: TARGET.portalGuestGross,
		sourceTotalPayoutAmount: TARGET.hotelRunnerReportedAmount,
		sourceTotalPayoutCurrency: TARGET.sourceCurrency,
		totalGuestPaymentAmount: commercial.gross,
		totalPayoutAmount: commercial.payout,
		currency: TARGET.propertyCurrency,
		propertyConversionVerified: true,
		exchangeRateToSar: commercial.conversion.rate,
		exchangeRateSource: commercial.conversion.provenance.sourceType,
		amountConvertedAt: commercial.conversionFetchedAt.toISOString(),
		currencyConversionEvidence: cloneBson(commercial.conversion),
		...optional,
	};
}

function protectedSnapshot(document = {}) {
	const snapshot = v1.commercialProtectedSnapshot(document);
	if (snapshot?.adminPricing) delete snapshot.adminPricing.commercialResolution;
	if (snapshot?.supplierData) {
		delete snapshot.supplierData.otaCommercialMaterializationRepair;
		delete snapshot.supplierData.otaCommercialEvidenceStaleReason;
	}
	snapshot.reservationAuditLog = (
		Array.isArray(snapshot.reservationAuditLog)
			? snapshot.reservationAuditLog
			: []
	).filter((entry) => clean(entry?.repairId) !== REPAIR_ID);
	return snapshot;
}

function repairAuditEntry({
	releaseSha,
	repairAt,
	originalHash,
	commercial,
	lineage,
}) {
	return {
		at: new Date(repairAt),
		source: "guarded-expedia-commercial-materialization",
		action: "trusted-conversion-commercial-materialization",
		provider: "expedia",
		repairId: REPAIR_ID,
		predecessorRepairId: v1.REPAIR_ID,
		releaseSha: lower(releaseSha),
		sourceJobHash: commercial.sourceJobHash,
		evidenceHash: commercial.evidence.evidenceHash,
		conversionEvidenceHash: commercial.conversionHash,
		originalDocumentHash: originalHash,
		predecessorManifestHash: lineage.manifestHash,
		predecessorBackupSetSha256: lineage.backup.backupSetSha256,
		backupCollection: BACKUP_COLLECTION,
		vendorApiCalls: 0,
	};
}

function buildExpectedDocument({
	reservation,
	event,
	job,
	releaseSha,
	repairAt,
	portalSelection,
	lineage,
}) {
	assertExactV1PostState(reservation, lineage);
	const originalHash = canonicalEjsonSha256(reservation);
	const commercial = buildCommercialEvidence({
		reservation,
		event,
		job,
		portalSelection,
		lineage,
		plannedAt: repairAt,
	});
	const rooms = buildWeightedPricing(reservation, commercial);
	const paymentSummary = materializedPaymentSummary(
		commercial.candidate,
		commercial,
		commercial.sourceJobHash
	);
	const conversionSource = commercial.conversion.provenance.sourceType;
	const convertedAt = new Date(commercial.conversionFetchedAt);
	const next = cloneBson(reservation);
	next.total_amount = commercial.gross;
	next.commission = 0;
	next.commission_ota = null;
	next.pickedRoomsType = cloneBson(rooms);
	next.pickedRoomsPricing = cloneBson(rooms);
	next.adminPricing = {
		...(next.adminPricing || {}),
		clientTotal: commercial.gross,
		netAfterExpensesTotal: commercial.payout,
		otaExpenseTotal: commercial.deduction,
		platformMarginTotal: commercial.margin,
		commissionAmount: 0,
		commercialVerified: true,
		commercialVerificationState: commercial.evidence.verificationState,
		commercialResolution: commercial.evidence.verificationState,
		commercialEvidenceHash: commercial.evidence.evidenceHash,
		defaultDeductionApplied: false,
		defaultDeductionRate: null,
		payoutFallbackReason: "",
		source: "authenticated_provider_portal",
		provider: "expedia",
		providerLabel: "Expedia",
		sourceCurrency: TARGET.sourceCurrency,
		propertyCurrency: TARGET.propertyCurrency,
		sourceAmount: TARGET.portalGuestGross,
		sourceGuestGross: TARGET.portalGuestGross,
		sourceHotelPayout: TARGET.hotelRunnerReportedAmount,
		propertyConversionVerified: true,
		hotelRunnerAmountRole: "hotel_payout",
		sourceExchangeRateToSar: commercial.conversion.rate,
		sourceExchangeRateSource: conversionSource,
		exchangeRateToSar: commercial.conversion.rate,
		exchangeRateSource: conversionSource,
		amountConvertedAt: convertedAt,
	};
	next.ota_financial_summary = {
		...(next.ota_financial_summary || {}),
		show: true,
		source: "authenticated_provider_portal",
		provider: "expedia",
		providerLabel: "Expedia",
		currency: TARGET.propertyCurrency,
		clientTotal: commercial.gross,
		hotelVisibleAmount: TARGET.rootTotal,
		netAfterExpenses: commercial.payout,
		netAfterOtaExpenses: commercial.payout,
		otaExpenseTotal: commercial.deduction,
		platformProfit: commercial.margin,
		commissionAmount: 0,
		otaCommissionAmount: null,
		otaDeductionBreakdown: [],
		unclassifiedOtaDeduction: commercial.deduction,
		commercialVerified: true,
		commercialVerificationState: commercial.evidence.verificationState,
		commercialEvidenceHash: commercial.evidence.evidenceHash,
		sourceCurrency: TARGET.sourceCurrency,
		propertyCurrency: TARGET.propertyCurrency,
		sourceAmount: TARGET.portalGuestGross,
		sourceGuestGross: TARGET.portalGuestGross,
		sourceHotelPayout: TARGET.hotelRunnerReportedAmount,
		propertyConversionVerified: true,
		hotelRunnerAmountRole: "hotel_payout",
		paymentCollectionModel: "ota_collect",
		payoutFallbackReason: "",
		paymentSummary,
		sourceExchangeRateToSar: commercial.conversion.rate,
		sourceExchangeRateSource: conversionSource,
		exchangeRateToSar: commercial.conversion.rate,
		exchangeRateSource: conversionSource,
		amountConvertedAt: convertedAt,
	};
	next.supplierData = {
		...(next.supplierData || {}),
		otaAmount: TARGET.portalGuestGross,
		otaAmountSar: commercial.gross,
		otaAmountConvertedAt: convertedAt,
		otaCurrency: TARGET.sourceCurrency,
		otaSourceCurrency: TARGET.sourceCurrency,
		otaSourceAmount: TARGET.portalGuestGross,
		otaSourceAmountHint:
			TARGET.sourceCurrency + " " + TARGET.portalGuestGross.toFixed(2),
		otaPropertyCurrency: TARGET.propertyCurrency,
		otaExchangeRateToSar: commercial.conversion.rate,
		otaExchangeRateSource: conversionSource,
		otaSourceExchangeRateToSar: commercial.conversion.rate,
		otaSourceExchangeRateSource: conversionSource,
		otaPaymentSummary: paymentSummary,
		otaPaymentCollectionModel: "ota_collect",
		otaDeductionComponents: [],
		otaTotalPayoutSar: commercial.payout,
		otaExpenseTotalSar: commercial.deduction,
		otaPlatformMarginSar: commercial.margin,
		otaCommissionSar: null,
		otaCommissionSource: "",
		otaCommissionSourceBacked: false,
		otaPayoutFallbackReason: "",
		otaCommercialEvidenceStaleReason: "",
		otaCommercialEvidence: cloneBson(commercial.evidence),
		otaCommercialMaterializationRepair: {
			repairId: REPAIR_ID,
			predecessorRepairId: v1.REPAIR_ID,
			releaseSha: lower(releaseSha),
			appliedAt: new Date(repairAt),
			sourceJobHash: commercial.sourceJobHash,
			evidenceHash: commercial.evidence.evidenceHash,
			conversionEvidenceHash: commercial.conversionHash,
			rootEvidenceHash: commercial.rootHash,
			originalDocumentHash: originalHash,
			predecessorManifestHash: lineage.manifestHash,
			predecessorBackupSetSha256: lineage.backup.backupSetSha256,
			propertyConversionVerified: true,
			vendorApiCalls: 0,
		},
	};
	next.reservationAuditLog = [
		...(Array.isArray(next.reservationAuditLog)
			? next.reservationAuditLog
			: []),
		repairAuditEntry({
			releaseSha,
			repairAt,
			originalHash,
			commercial,
			lineage,
		}),
	];
	next.updatedAt = new Date(repairAt);
	next.__v = TARGET.reservationVersion + 2;
	assertPostconditions({
		before: reservation,
		after: next,
		commercial,
		lineage,
	});
	return {
		expectedDocument: next,
		commercial,
		paymentSummary,
	};
}

function assertPostconditions({ before, after, commercial, lineage }) {
	const validation = validateOtaCommercialEvidence(
		after?.supplierData?.otaCommercialEvidence
	);
	if (
		!validation.ok ||
		after?.supplierData?.otaCommercialEvidence?.evidenceHash !==
			commercial.evidence.evidenceHash
	) {
		fail(
			"Persisted common commercial evidence is invalid.",
			"EXPEDIA_V2_POSTCONDITION_FAILED"
		);
	}
	const requiredAmounts = [
		[after?.total_amount, commercial.gross],
		[after?.adminPricing?.clientTotal, commercial.gross],
		[after?.adminPricing?.netAfterExpensesTotal, commercial.payout],
		[after?.adminPricing?.otaExpenseTotal, commercial.deduction],
		[after?.adminPricing?.platformMarginTotal, commercial.margin],
		[after?.ota_financial_summary?.clientTotal, commercial.gross],
		[after?.ota_financial_summary?.netAfterExpenses, commercial.payout],
		[after?.ota_financial_summary?.netAfterOtaExpenses, commercial.payout],
		[after?.ota_financial_summary?.otaExpenseTotal, commercial.deduction],
		[after?.ota_financial_summary?.platformProfit, commercial.margin],
		[after?.supplierData?.otaAmount, TARGET.portalGuestGross],
		[after?.supplierData?.otaAmountSar, commercial.gross],
		[after?.supplierData?.otaSourceAmount, TARGET.portalGuestGross],
		[after?.supplierData?.otaTotalPayoutSar, commercial.payout],
		[after?.supplierData?.otaExpenseTotalSar, commercial.deduction],
		[after?.supplierData?.otaPlatformMarginSar, commercial.margin],
	];
	if (
		requiredAmounts.some(([actual, expected]) => !sameMoney(actual, expected))
	) {
		fail(
			"A canonical commercial amount does not match the trusted plan.",
			"EXPEDIA_V2_POSTCONDITION_FAILED"
		);
	}
	const rates = [
		after?.adminPricing?.sourceExchangeRateToSar,
		after?.adminPricing?.exchangeRateToSar,
		after?.ota_financial_summary?.sourceExchangeRateToSar,
		after?.ota_financial_summary?.exchangeRateToSar,
		after?.supplierData?.otaExchangeRateToSar,
		after?.supplierData?.otaSourceExchangeRateToSar,
		after?.supplierData?.otaPaymentSummary?.exchangeRateToSar,
	];
	if (
		rates.some((rate) => !sameRate(rate, commercial.conversion.rate)) ||
		after?.adminPricing?.commercialVerified !== true ||
		after?.ota_financial_summary?.commercialVerified !== true ||
		after?.adminPricing?.propertyConversionVerified !== true ||
		after?.ota_financial_summary?.propertyConversionVerified !== true ||
		after?.supplierData?.otaPaymentSummary?.propertyConversionVerified !==
			true ||
		after?.adminPricing?.commercialVerificationState !== "verified" ||
		after?.ota_financial_summary?.commercialVerificationState !== "verified" ||
		Number(after?.commission) !== 0 ||
		after?.commission_ota !== null ||
		after?.supplierData?.otaCommissionSar !== null ||
		after?.adminPricing?.defaultDeductionApplied !== false ||
		after?.adminPricing?.defaultDeductionRate !== null ||
		Number(after?.__v) !== TARGET.reservationVersion + 2
	) {
		fail(
			"Verified conversion, commission, or version postcondition failed.",
			"EXPEDIA_V2_POSTCONDITION_FAILED"
		);
	}
	if (
		canonicalEjsonSha256(after?.pickedRoomsPricing) !==
			canonicalEjsonSha256(buildWeightedPricing(before, commercial)) ||
		canonicalEjsonSha256(after?.pickedRoomsType) !==
			canonicalEjsonSha256(after?.pickedRoomsPricing)
	) {
		fail(
			"Room/day commercial allocations diverged from stored weights.",
			"EXPEDIA_V2_POSTCONDITION_FAILED"
		);
	}
	if (
		canonicalEjsonSha256(protectedSnapshot(before)) !==
			canonicalEjsonSha256(protectedSnapshot(after)) ||
		canonicalEjsonSha256(before?.supplierData?.otaCommercialRepair) !==
			canonicalEjsonSha256(after?.supplierData?.otaCommercialRepair) ||
		canonicalEjsonSha256(
			(before?.reservationAuditLog || []).filter(
				(entry) => clean(entry?.repairId) === v1.REPAIR_ID
			)
		) !==
			canonicalEjsonSha256(
				(after?.reservationAuditLog || []).filter(
					(entry) => clean(entry?.repairId) === v1.REPAIR_ID
				)
			) ||
		canonicalEjsonSha256(before?.supplierData?.hotelRunner) !==
			canonicalEjsonSha256(after?.supplierData?.hotelRunner)
	) {
		fail(
			"A protected identity, lifecycle, guest, stay, room, root, payment, or v1 fact changed.",
			"EXPEDIA_V2_POSTCONDITION_FAILED"
		);
	}
	if (
		clean(after?.supplierData?.otaCommercialRepair?.repairId) !==
			v1.REPAIR_ID ||
		clean(after?.supplierData?.otaCommercialMaterializationRepair?.repairId) !==
			REPAIR_ID ||
		after?.supplierData?.otaCommercialMaterializationRepair
			?.predecessorManifestHash !== lineage.manifestHash ||
		after?.supplierData?.otaCommercialMaterializationRepair
			?.predecessorBackupSetSha256 !== lineage.backup.backupSetSha256
	) {
		fail(
			"The v2 lineage markers are incomplete.",
			"EXPEDIA_V2_POSTCONDITION_FAILED"
		);
	}
	const v2Audits = (after?.reservationAuditLog || []).filter(
		(entry) => clean(entry?.repairId) === REPAIR_ID
	);
	if (v2Audits.length !== 1 || Number(v2Audits[0]?.vendorApiCalls) !== 0) {
		fail(
			"The reservation lacks one exact zero-call v2 audit.",
			"EXPEDIA_V2_POSTCONDITION_FAILED"
		);
	}
	assertOperationallySafe(after, before);
	return true;
}

function isV2Marker(reservation = {}) {
	return (
		clean(
			reservation?.supplierData?.otaCommercialMaterializationRepair?.repairId
		) === REPAIR_ID
	);
}

function immutableScope(scope, portalSelection, lineage) {
	return {
		reservationHash: canonicalEjsonSha256(scope.reservation),
		eventHash: canonicalEjsonSha256(scope.event),
		mirrorHash: canonicalEjsonSha256(scope.mirror),
		portalJobHash: canonicalEjsonSha256(scope.job),
		portalSelectionHash: canonicalEjsonSha256(portalSelection),
		predecessorManifestHash: lineage.manifestHash,
		predecessorBackupSetSha256: lineage.backup.backupSetSha256,
	};
}

async function loadPlan({ db, releaseSha, plannedAt, portalSelection }) {
	const lineage = await loadV1Lineage(db);
	const scope = await loadRawScope(db, portalSelection);
	assertPredecessorLiveEvidence(scope, lineage);
	const existingManifest = await db
		.collection(MANIFEST_COLLECTION)
		.findOne({ _id: REPAIR_ID }, primaryReadOptions());
	if (isV2Marker(scope.reservation)) {
		const backup = await loadAndVerifyBackup(db, portalSelection);
		await verifyImmutableEvidenceAgainstBackup(db, backup);
		const reservationRecord = backup.byRole.get("reservation_before");
		if (
			existingManifest?.state !== "applied" ||
			canonicalEjsonSha256(scope.reservation) !==
				reservationRecord.expectedRepairedHash
		) {
			fail(
				"The marked v2 reservation is not its exact applied EJSON.",
				"EXPEDIA_V2_POST_STATE_INVALID"
			);
		}
		const commercial = buildCommercialEvidence({
			reservation: reservationRecord.originalDocument,
			event: scope.event,
			job: scope.job,
			portalSelection,
			lineage,
			plannedAt: backup.manifest.proofPlannedAt,
		});
		assertPostconditions({
			before: reservationRecord.originalDocument,
			after: scope.reservation,
			commercial,
			lineage,
		});
		return {
			state: "already_applied",
			repairId: REPAIR_ID,
			releaseSha: lower(releaseSha),
			plannedAt: new Date(plannedAt),
			scope,
			lineage,
			backup,
			commercial,
			portalSelection,
			originalHash: reservationRecord.originalHash,
			expectedHash: reservationRecord.expectedRepairedHash,
			planHash: backup.manifest.planHash,
		};
	}
	if (existingManifest) {
		fail(
			"A v2 manifest already exists without the exact applied marker.",
			"EXPEDIA_V2_MANIFEST_CONFLICT"
		);
	}
	assertExactV1PostState(scope.reservation, lineage);
	const built = buildExpectedDocument({
		reservation: scope.reservation,
		event: scope.event,
		job: scope.job,
		releaseSha,
		repairAt: plannedAt,
		portalSelection,
		lineage,
	});
	const originalHash = canonicalEjsonSha256(scope.reservation);
	const expectedHash = canonicalEjsonSha256(built.expectedDocument);
	const protectedHash = canonicalEjsonSha256(
		protectedSnapshot(scope.reservation)
	);
	const immutable = immutableScope(scope, portalSelection, lineage);
	const proofBasis = {
		version: 2,
		action: "materialize_trusted_conversion",
		repairId: REPAIR_ID,
		releaseSha: lower(releaseSha),
		plannedAt: new Date(plannedAt).toISOString(),
		targetFingerprint: sha256(
			[
				TARGET.hotelId,
				TARGET.reservationMongoId,
				TARGET.pmsConfirmationNumber,
				TARGET.otaBookingId,
				TARGET.checkinDate,
				TARGET.checkoutDate,
			].join(":")
		),
		originalHash,
		expectedHash,
		protectedHash,
		evidenceHash: built.commercial.evidence.evidenceHash,
		conversionEvidenceHash: built.commercial.conversionHash,
		conversionRate: built.commercial.conversion.rate,
		immutable,
		vendorApiCalls: 0,
	};
	return {
		state: "ready",
		repairId: REPAIR_ID,
		releaseSha: lower(releaseSha),
		plannedAt: new Date(plannedAt),
		portalSelection,
		scope,
		lineage,
		immutable,
		originalDocument: cloneBson(scope.reservation),
		expectedDocument: built.expectedDocument,
		originalHash,
		expectedHash,
		protectedHash,
		commercial: built.commercial,
		planHash: canonicalEjsonSha256(proofBasis),
	};
}

function backupRecord({
	role,
	collection,
	document,
	expectedRepairedHash = "",
	capturedAt,
}) {
	const originalDocument = cloneBson(document);
	const originalEjson = v1.canonicalEjsonString(originalDocument);
	const originalHash = canonicalEjsonSha256(originalDocument);
	const base = {
		_id: REPAIR_ID + ":" + role,
		repairId: REPAIR_ID,
		role,
		sourceCollection: collection,
		documentId: clean(document?._id),
		capturedAt: new Date(capturedAt),
		originalHash,
		originalEjsonSha256: sha256(originalEjson),
		originalEjson,
		originalDocument,
		expectedRepairedHash,
	};
	return { ...base, recordHash: canonicalEjsonSha256(base) };
}

const BACKUP_ROLES = Object.freeze([
	"reservation_before",
	"hotelrunner_event_evidence",
	"hotelrunner_mirror_evidence",
	"expedia_portal_job_evidence",
]);

function buildBackupRecords(plan) {
	if (plan.state !== "ready") {
		fail(
			"Only an exact ready plan can create v2 backups.",
			"EXPEDIA_V2_BACKUP_INVALID"
		);
	}
	return [
		backupRecord({
			role: BACKUP_ROLES[0],
			collection: COLLECTIONS.reservation,
			document: plan.originalDocument,
			expectedRepairedHash: plan.expectedHash,
			capturedAt: plan.plannedAt,
		}),
		backupRecord({
			role: BACKUP_ROLES[1],
			collection: COLLECTIONS.event,
			document: plan.scope.event,
			capturedAt: plan.plannedAt,
		}),
		backupRecord({
			role: BACKUP_ROLES[2],
			collection: COLLECTIONS.mirror,
			document: plan.scope.mirror,
			capturedAt: plan.plannedAt,
		}),
		backupRecord({
			role: BACKUP_ROLES[3],
			collection: COLLECTIONS.portalJob,
			document: plan.scope.job,
			capturedAt: plan.plannedAt,
		}),
	];
}

function verifyBackupRecords(records, manifest = null) {
	if (!Array.isArray(records) || records.length !== BACKUP_ROLES.length) {
		fail(
			"The v2 backup must contain exactly four full EJSON/BSON records.",
			"EXPEDIA_V2_BACKUP_INVALID"
		);
	}
	const byRole = new Map();
	for (const record of records) {
		const base = { ...record };
		delete base.recordHash;
		if (
			clean(record?.repairId) !== REPAIR_ID ||
			!BACKUP_ROLES.includes(record?.role) ||
			byRole.has(record?.role) ||
			canonicalEjsonSha256(base) !== record?.recordHash ||
			canonicalEjsonSha256(record?.originalDocument) !== record?.originalHash ||
			v1.canonicalEjsonString(record?.originalDocument) !==
				record?.originalEjson ||
			sha256(record?.originalEjson) !== record?.originalEjsonSha256
		) {
			fail(
				"A v2 permanent backup record failed integrity.",
				"EXPEDIA_V2_BACKUP_INVALID"
			);
		}
		byRole.set(record.role, record);
	}
	if (BACKUP_ROLES.some((role) => !byRole.has(role))) {
		fail("A required v2 backup role is absent.", "EXPEDIA_V2_BACKUP_INVALID");
	}
	const exactBindings = [
		["reservation_before", COLLECTIONS.reservation, TARGET.reservationMongoId],
		["hotelrunner_event_evidence", COLLECTIONS.event, TARGET.eventId],
		["hotelrunner_mirror_evidence", COLLECTIONS.mirror, TARGET.mirrorId],
	];
	for (const [role, collection, documentId] of exactBindings) {
		const record = byRole.get(role);
		if (
			record.sourceCollection !== collection ||
			clean(record.documentId) !== documentId ||
			clean(record.originalDocument?._id) !== documentId
		) {
			fail(
				"A v2 backup role is bound to the wrong source document.",
				"EXPEDIA_V2_BACKUP_INVALID"
			);
		}
	}
	const portalBinding = byRole.get("expedia_portal_job_evidence");
	if (
		portalBinding.sourceCollection !== COLLECTIONS.portalJob ||
		!ObjectId.isValid(clean(portalBinding.documentId)) ||
		clean(portalBinding.originalDocument?._id) !==
			clean(portalBinding.documentId)
	) {
		fail(
			"The v2 portal backup is bound to the wrong source document.",
			"EXPEDIA_V2_BACKUP_INVALID"
		);
	}
	const backupSetSha256 = canonicalEjsonSha256(
		[...byRole.values()]
			.map((record) => ({ id: record._id, recordHash: record.recordHash }))
			.sort((left, right) => left.id.localeCompare(right.id))
	);
	if (manifest) {
		const portalRecord = byRole.get("expedia_portal_job_evidence");
		const reservationRecord = byRole.get("reservation_before");
		if (
			clean(manifest?._id) !== REPAIR_ID ||
			clean(manifest?.repairId) !== REPAIR_ID ||
			!["backing_up", "backed_up", "applied", "rolled_back"].includes(
				manifest?.state
			) ||
			!/^[a-f0-9]{40}$/.test(lower(manifest?.releaseSha)) ||
			!/^[a-f0-9]{64}$/.test(lower(manifest?.planHash)) ||
			!/^[a-f0-9]{64}$/.test(lower(manifest?.evidenceHash)) ||
			!/^[a-f0-9]{64}$/.test(lower(manifest?.conversionEvidenceHash)) ||
			!Number.isFinite(Number(manifest?.conversionRate)) ||
			Number(manifest?.conversionRate) <= 0 ||
			manifest?.predecessorRepairId !== v1.REPAIR_ID ||
			!/^[a-f0-9]{64}$/.test(lower(manifest?.predecessorManifestHash)) ||
			!/^[a-f0-9]{64}$/.test(lower(manifest?.predecessorBackupSetSha256)) ||
			Number(manifest?.vendorApiCalls || 0) !== 0 ||
			manifest?.backupCollection !== BACKUP_COLLECTION ||
			Number(manifest?.backupRecordCount) !== BACKUP_ROLES.length ||
			manifest?.backupSetSha256 !== backupSetSha256 ||
			manifest?.originalHash !== reservationRecord.originalHash ||
			manifest?.expectedRepairedHash !==
				reservationRecord.expectedRepairedHash ||
			clean(manifest?.portalJobId) !== clean(portalRecord?.documentId) ||
			manifest?.portalJobHash !== portalRecord?.originalHash ||
			clean(portalRecord?.originalDocument?.jobNumber) !==
				clean(manifest?.portalJobNumber)
		) {
			fail(
				"The v2 manifest no longer binds its permanent backup set.",
				"EXPEDIA_V2_BACKUP_INVALID"
			);
		}
		for (const record of records) {
			if (manifest?.backupRecordHashes?.[record.role] !== record.recordHash) {
				fail("A v2 manifest record hash changed.", "EXPEDIA_V2_BACKUP_INVALID");
			}
		}
		exactDate(manifest.proofPlannedAt, "v2 proof plan timestamp");
		if (
			manifest.state === "applied" &&
			(manifest.appliedDocumentHash !==
				reservationRecord.expectedRepairedHash ||
				!manifest.appliedAt)
		) {
			fail(
				"The applied v2 manifest lacks its exact post-state.",
				"EXPEDIA_V2_BACKUP_INVALID"
			);
		}
		if (manifest.state === "applied") {
			exactDate(manifest.appliedAt, "v2 applied timestamp");
		}
		if (
			manifest.state === "rolled_back" &&
			(manifest.rollbackDocumentHash !== reservationRecord.originalHash ||
				!manifest.rolledBackAt)
		) {
			fail(
				"The rolled-back v2 manifest lacks its exact restored state.",
				"EXPEDIA_V2_BACKUP_INVALID"
			);
		}
		if (manifest.state === "rolled_back") {
			exactDate(manifest.rolledBackAt, "v2 rollback timestamp");
		}
	}
	return { byRole, backupSetSha256 };
}

async function readBackupRecords(db) {
	const records = [];
	for (const role of BACKUP_ROLES) {
		const record = await db
			.collection(BACKUP_COLLECTION)
			.findOne({ _id: REPAIR_ID + ":" + role }, primaryReadOptions());
		if (record) records.push(record);
	}
	return records;
}

async function loadAndVerifyBackup(db, portalSelection) {
	const manifest = await db
		.collection(MANIFEST_COLLECTION)
		.findOne({ _id: REPAIR_ID }, primaryReadOptions());
	if (
		!manifest ||
		clean(manifest?.portalJobId) !== portalSelection.jobId ||
		clean(manifest?.portalJobNumber) !== portalSelection.jobNumber
	) {
		fail(
			"The v2 manifest is absent or bound to different evidence.",
			"EXPEDIA_V2_BACKUP_INVALID"
		);
	}
	const records = await readBackupRecords(db);
	const verified = verifyBackupRecords(records, manifest);
	const lineage = await loadV1Lineage(db);
	if (
		manifest?.predecessorRepairId !== v1.REPAIR_ID ||
		manifest?.predecessorManifestHash !== lineage.manifestHash ||
		manifest?.predecessorBackupSetSha256 !== lineage.backup.backupSetSha256
	) {
		fail(
			"The v1 predecessor proof changed after v2 planning.",
			"EXPEDIA_V2_V1_LINEAGE_INVALID"
		);
	}
	return { manifest, records, lineage, ...verified };
}

async function ensureBackup(db, plan) {
	const records = buildBackupRecords(plan);
	const verified = verifyBackupRecords(records);
	const backupRecordHashes = Object.fromEntries(
		records.map((record) => [record.role, record.recordHash])
	);
	const manifestDocument = {
		_id: REPAIR_ID,
		repairId: REPAIR_ID,
		state: "backing_up",
		releaseSha: plan.releaseSha,
		planHash: plan.planHash,
		proofPlannedAt: new Date(plan.plannedAt),
		originalHash: plan.originalHash,
		expectedRepairedHash: plan.expectedHash,
		protectedHash: plan.protectedHash,
		evidenceHash: plan.commercial.evidence.evidenceHash,
		conversionEvidenceHash: plan.commercial.conversionHash,
		conversionRate: plan.commercial.conversion.rate,
		backupCollection: BACKUP_COLLECTION,
		backupRecordCount: records.length,
		backupRecordHashes,
		backupSetSha256: verified.backupSetSha256,
		portalJobId: plan.portalSelection.jobId,
		portalJobNumber: plan.portalSelection.jobNumber,
		portalJobHash: plan.commercial.sourceJobHash,
		predecessorRepairId: v1.REPAIR_ID,
		predecessorManifestHash: plan.lineage.manifestHash,
		predecessorBackupSetSha256: plan.lineage.backup.backupSetSha256,
		vendorApiCalls: 0,
		createdAt: new Date(plan.plannedAt),
	};
	const manifests = db.collection(MANIFEST_COLLECTION);
	let existing = await manifests.findOne(
		{ _id: REPAIR_ID },
		primaryReadOptions()
	);
	if (!existing) {
		try {
			await manifests.insertOne(
				cloneBson(manifestDocument),
				majorityWriteOptions()
			);
			existing = manifestDocument;
		} catch (_error) {
			existing = await manifests.findOne(
				{ _id: REPAIR_ID },
				primaryReadOptions()
			);
		}
	}
	const immutableFields = [
		"releaseSha",
		"planHash",
		"proofPlannedAt",
		"originalHash",
		"expectedRepairedHash",
		"protectedHash",
		"evidenceHash",
		"conversionEvidenceHash",
		"conversionRate",
		"backupCollection",
		"backupRecordCount",
		"backupRecordHashes",
		"backupSetSha256",
		"portalJobId",
		"portalJobNumber",
		"portalJobHash",
		"predecessorRepairId",
		"predecessorManifestHash",
		"predecessorBackupSetSha256",
		"vendorApiCalls",
	];
	if (
		!existing ||
		!["backing_up", "backed_up", "applied"].includes(existing.state) ||
		immutableFields.some(
			(field) =>
				canonicalEjsonSha256(existing[field]) !==
				canonicalEjsonSha256(manifestDocument[field])
		)
	) {
		fail(
			"An existing v2 manifest conflicts with this proof.",
			"EXPEDIA_V2_MANIFEST_CONFLICT"
		);
	}
	const backups = db.collection(BACKUP_COLLECTION);
	for (const record of records) {
		const saved = await backups.findOne(
			{ _id: record._id },
			primaryReadOptions()
		);
		if (!saved) {
			try {
				await backups.insertOne(cloneBson(record), majorityWriteOptions());
			} catch (_error) {
				const raced = await backups.findOne(
					{ _id: record._id },
					primaryReadOptions()
				);
				if (!raced || raced.recordHash !== record.recordHash) {
					fail(
						"A v2 permanent backup could not be persisted.",
						"EXPEDIA_V2_BACKUP_INVALID"
					);
				}
			}
		} else if (saved.recordHash !== record.recordHash) {
			fail(
				"An existing v2 permanent backup conflicts.",
				"EXPEDIA_V2_BACKUP_INVALID"
			);
		}
	}
	verifyBackupRecords(await readBackupRecords(db), manifestDocument);
	if (existing.state === "backing_up") {
		const result = await manifests.updateOne(
			{
				_id: REPAIR_ID,
				state: "backing_up",
				planHash: plan.planHash,
				backupSetSha256: verified.backupSetSha256,
			},
			{ $set: { state: "backed_up", backupVerifiedAt: new Date() } },
			majorityWriteOptions()
		);
		if (Number(result?.matchedCount ?? result?.n ?? 0) !== 1) {
			fail(
				"The v2 manifest changed while finalizing backup.",
				"EXPEDIA_V2_MANIFEST_CONFLICT"
			);
		}
	}
	return loadAndVerifyBackup(db, plan.portalSelection);
}

async function verifyImmutableEvidenceAgainstBackup(db, backup) {
	for (const [role, collection] of [
		["hotelrunner_event_evidence", COLLECTIONS.event],
		["hotelrunner_mirror_evidence", COLLECTIONS.mirror],
		["expedia_portal_job_evidence", COLLECTIONS.portalJob],
	]) {
		const record = backup.byRole.get(role);
		const current = await db
			.collection(collection)
			.findOne({ _id: objectId(record.documentId) }, primaryReadOptions());
		if (!current || canonicalEjsonSha256(current) !== record.originalHash) {
			fail(
				"Immutable v2 evidence changed after backup.",
				"EXPEDIA_V2_EVIDENCE_TAMPERED"
			);
		}
	}
	const lineage = await loadV1Lineage(db);
	if (
		lineage.manifestHash !== backup.manifest.predecessorManifestHash ||
		lineage.backup.backupSetSha256 !==
			backup.manifest.predecessorBackupSetSha256
	) {
		fail(
			"Immutable v1 lineage changed after v2 backup.",
			"EXPEDIA_V2_V1_LINEAGE_INVALID"
		);
	}
}

async function replaceWithHashReadback({
	collection,
	before,
	after,
	beforeHash,
	afterHash,
}) {
	let acknowledgementError = null;
	try {
		const result = await collection.replaceOne(
			buildExactCasFilter(before),
			cloneBson(after),
			majorityWriteOptions()
		);
		if (
			result?.acknowledged === false ||
			Number(result?.matchedCount ?? result?.n ?? 0) !== 1 ||
			Number(result?.modifiedCount ?? result?.nModified ?? 0) !== 1
		) {
			throw new Error("cas rejected");
		}
	} catch (error) {
		acknowledgementError = error;
	}
	const observed = await collection.findOne(
		{ _id: objectId(TARGET.reservationMongoId) },
		primaryReadOptions()
	);
	const observedHash = observed ? canonicalEjsonSha256(observed) : "";
	if (observedHash === afterHash) {
		return {
			document: observed,
			acknowledgementLost: Boolean(acknowledgementError),
		};
	}
	if (observedHash === beforeHash) {
		fail("The full-document CAS did not commit.", "EXPEDIA_V2_CAS_REJECTED");
	}
	fail(
		"The reservation is neither exact before nor exact after EJSON.",
		"EXPEDIA_V2_MANUAL_INTERVENTION_REQUIRED"
	);
}

async function finalizeAppliedManifest(db, plan, backup) {
	const collection = db.collection(MANIFEST_COLLECTION);
	const result = await collection.updateOne(
		buildExactCasFilter(backup.manifest),
		{
			$set: {
				state: "applied",
				appliedAt: new Date(),
				appliedDocumentHash: plan.expectedHash,
				vendorApiCalls: 0,
			},
		},
		majorityWriteOptions()
	);
	if (Number(result?.matchedCount ?? result?.n ?? 0) !== 1) {
		const observed = await collection.findOne(
			{ _id: REPAIR_ID },
			primaryReadOptions()
		);
		if (
			observed?.state !== "applied" ||
			observed?.appliedDocumentHash !== plan.expectedHash
		) {
			fail(
				"The reservation committed but its v2 manifest did not.",
				"EXPEDIA_V2_MANIFEST_CONFLICT"
			);
		}
	}
}

async function applyRepairPlan({ db, plan }) {
	if (plan.state === "already_applied") {
		return {
			state: "already_applied",
			changed: 0,
			backupSetSha256: plan.backup.backupSetSha256,
			vendorApiCalls: 0,
		};
	}
	if (plan.state !== "ready") {
		fail("Only an exact ready plan can be applied.", "EXPEDIA_V2_PLAN_INVALID");
	}
	const backup = await ensureBackup(db, plan);
	await verifyImmutableEvidenceAgainstBackup(db, backup);
	const reservationRecord = backup.byRole.get("reservation_before");
	if (
		reservationRecord.originalHash !== plan.originalHash ||
		reservationRecord.expectedRepairedHash !== plan.expectedHash
	) {
		fail(
			"The permanent reservation backup conflicts with the plan.",
			"EXPEDIA_V2_BACKUP_INVALID"
		);
	}
	const current = await db
		.collection(COLLECTIONS.reservation)
		.findOne(
			{ _id: objectId(TARGET.reservationMongoId) },
			primaryReadOptions()
		);
	if (!current || canonicalEjsonSha256(current) !== plan.originalHash) {
		fail(
			"The reservation changed after the approved dry run.",
			"EXPEDIA_V2_CAS_REJECTED"
		);
	}
	assertExactV1PostState(current, plan.lineage);
	const replacement = await replaceWithHashReadback({
		collection: db.collection(COLLECTIONS.reservation),
		before: plan.originalDocument,
		after: plan.expectedDocument,
		beforeHash: plan.originalHash,
		afterHash: plan.expectedHash,
	});
	assertPostconditions({
		before: plan.originalDocument,
		after: replacement.document,
		commercial: plan.commercial,
		lineage: plan.lineage,
	});
	await verifyImmutableEvidenceAgainstBackup(db, backup);
	await finalizeAppliedManifest(db, plan, backup);
	return {
		state: "applied",
		changed: 1,
		acknowledgementLost: replacement.acknowledgementLost,
		backupSetSha256: backup.backupSetSha256,
		vendorApiCalls: 0,
	};
}

async function loadRollbackPlan({
	db,
	releaseSha,
	plannedAt,
	portalSelection,
}) {
	const backup = await loadAndVerifyBackup(db, portalSelection);
	await verifyImmutableEvidenceAgainstBackup(db, backup);
	const reservationRecord = backup.byRole.get("reservation_before");
	const current = await db
		.collection(COLLECTIONS.reservation)
		.findOne(
			{ _id: objectId(TARGET.reservationMongoId) },
			primaryReadOptions()
		);
	if (!current) {
		fail("The exact reservation is missing.", "EXPEDIA_V2_ROLLBACK_BLOCKED");
	}
	const currentHash = canonicalEjsonSha256(current);
	let state = "";
	if (currentHash === reservationRecord.originalHash) {
		state = "already_rolled_back";
	} else if (currentHash === reservationRecord.expectedRepairedHash) {
		state = "ready";
	} else {
		fail(
			"Rollback found neither exact v1 nor exact v2 EJSON.",
			"EXPEDIA_V2_ROLLBACK_BLOCKED"
		);
	}
	if (
		state === "ready" &&
		(!isV2Marker(current) || backup.manifest.state !== "applied")
	) {
		fail(
			"Rollback lacks the exact applied v2 marker.",
			"EXPEDIA_V2_ROLLBACK_BLOCKED"
		);
	}
	if (
		state === "already_rolled_back" &&
		backup.manifest.state !== "rolled_back"
	) {
		fail(
			"The v2 manifest does not prove the rollback transition.",
			"EXPEDIA_V2_ROLLBACK_BLOCKED"
		);
	}
	const proofBasis = {
		version: 2,
		action: "rollback",
		repairId: REPAIR_ID,
		releaseSha: lower(releaseSha),
		plannedAt: new Date(plannedAt).toISOString(),
		originalHash: reservationRecord.originalHash,
		expectedRepairedHash: reservationRecord.expectedRepairedHash,
		backupSetSha256: backup.backupSetSha256,
		manifestHash: canonicalEjsonSha256(backup.manifest),
		portalJobHash: backup.byRole.get("expedia_portal_job_evidence")
			.originalHash,
		predecessorManifestHash: backup.manifest.predecessorManifestHash,
		predecessorBackupSetSha256: backup.manifest.predecessorBackupSetSha256,
		vendorApiCalls: 0,
	};
	return {
		state,
		action: "rollback",
		repairId: REPAIR_ID,
		releaseSha: lower(releaseSha),
		plannedAt: new Date(plannedAt),
		planHash: canonicalEjsonSha256(proofBasis),
		portalSelection,
		backup,
		manifestHash: canonicalEjsonSha256(backup.manifest),
		currentDocument: current,
		originalDocument: reservationRecord.originalDocument,
		originalHash: reservationRecord.originalHash,
		expectedHash: reservationRecord.expectedRepairedHash,
	};
}

async function applyRollbackPlan({ db, plan }) {
	if (plan.state === "already_rolled_back") {
		return {
			state: "already_rolled_back",
			changed: 0,
			backupSetSha256: plan.backup.backupSetSha256,
			vendorApiCalls: 0,
		};
	}
	if (plan.state !== "ready") {
		fail(
			"Only an exact ready rollback can be applied.",
			"EXPEDIA_V2_ROLLBACK_BLOCKED"
		);
	}
	const currentBackup = await loadAndVerifyBackup(db, plan.portalSelection);
	if (canonicalEjsonSha256(currentBackup.manifest) !== plan.manifestHash) {
		fail(
			"The v2 manifest changed after rollback dry run.",
			"EXPEDIA_V2_PROOF_MISMATCH"
		);
	}
	await verifyImmutableEvidenceAgainstBackup(db, currentBackup);
	const replacement = await replaceWithHashReadback({
		collection: db.collection(COLLECTIONS.reservation),
		before: plan.currentDocument,
		after: plan.originalDocument,
		beforeHash: plan.expectedHash,
		afterHash: plan.originalHash,
	});
	if (
		canonicalEjsonSha256(replacement.document) !== plan.originalHash ||
		clean(replacement.document?.supplierData?.otaCommercialRepair?.repairId) !==
			v1.REPAIR_ID ||
		isV2Marker(replacement.document)
	) {
		fail(
			"Rollback did not restore exact v1 EJSON.",
			"EXPEDIA_V2_ROLLBACK_BLOCKED"
		);
	}
	const lineage = await loadV1Lineage(db);
	assertExactV1PostState(replacement.document, lineage);
	await verifyImmutableEvidenceAgainstBackup(db, plan.backup);
	const result = await db.collection(MANIFEST_COLLECTION).updateOne(
		buildExactCasFilter(currentBackup.manifest),
		{
			$set: {
				state: "rolled_back",
				rolledBackAt: new Date(),
				rolledBackReleaseSha: plan.releaseSha,
				rollbackDocumentHash: plan.originalHash,
				vendorApiCalls: 0,
			},
		},
		majorityWriteOptions()
	);
	if (Number(result?.matchedCount ?? result?.n ?? 0) !== 1) {
		const manifest = await db
			.collection(MANIFEST_COLLECTION)
			.findOne({ _id: REPAIR_ID }, primaryReadOptions());
		if (
			manifest?.state !== "rolled_back" ||
			manifest?.rollbackDocumentHash !== plan.originalHash
		) {
			fail(
				"Rollback restored v1 but its v2 manifest did not.",
				"EXPEDIA_V2_MANIFEST_CONFLICT"
			);
		}
	}
	return {
		state: "rolled_back",
		changed: 1,
		acknowledgementLost: replacement.acknowledgementLost,
		backupSetSha256: plan.backup.backupSetSha256,
		vendorApiCalls: 0,
	};
}

function sanitizedDailyAllocation(plan) {
	const document =
		plan.expectedDocument ||
		(plan.state === "already_applied" ? plan.scope?.reservation : null);
	const days = (
		Array.isArray(document?.pickedRoomsPricing)
			? document.pickedRoomsPricing
			: []
	).flatMap((room) =>
		Array.isArray(room?.pricingByDay) ? room.pricingByDay : []
	);
	return days.map((day) => ({
		guestGross: day.clientPrice,
		hotelPayout: day.netAfterExpenses,
		hotelRoot: day.rootPrice,
		deduction: day.otaExpenseAmount,
		margin: day.platformMargin,
	}));
}

function sanitizedForwardOutput(plan, mode, proof = "") {
	return {
		mode,
		repairId: REPAIR_ID,
		releaseSha: plan.releaseSha,
		state: plan.state,
		proof: mode === "dry_run" && plan.state === "ready" ? proof : undefined,
		proofExpiresInMinutes:
			mode === "dry_run" && plan.state === "ready"
				? PROOF_MAX_AGE_MS / 60_000
				: undefined,
		planHash: plan.planHash,
		reservationCountByPmsConfirmation: 1,
		reservationCountByProviderConfirmation: 1,
		identitiesConvergeOnOneReservation: true,
		hotelRunnerEventCount: 1,
		hotelRunnerMirrorCount: 1,
		provider: "expedia",
		channel: "expedia",
		scopeFingerprint: sha256(
			plan.originalHash + ":" + (plan.commercial?.sourceJobHash || "")
		),
		portalEvidenceHash:
			plan.commercial?.sourceJobHash ||
			plan.backup?.byRole?.get("expedia_portal_job_evidence")?.originalHash,
		commercialEvidenceHash: plan.commercial?.evidence?.evidenceHash,
		conversionEvidenceHash: plan.commercial?.conversionHash,
		commercial: plan.commercial
			? {
					sourceCurrency: TARGET.sourceCurrency,
					propertyCurrency: TARGET.propertyCurrency,
					sourceGuestGross: TARGET.portalGuestGross,
					sourceHotelPayout: TARGET.hotelRunnerReportedAmount,
					trustedRate: plan.commercial.conversion.rate,
					propertyGuestGross: plan.commercial.gross,
					propertyHotelPayout: plan.commercial.payout,
					propertyDeduction: plan.commercial.deduction,
					propertyHotelBase: TARGET.rootTotal,
					propertyMargin: plan.commercial.margin,
					pmsCommission: 0,
					explicitOtaCommission: null,
			  }
			: undefined,
		dailyCommercialReconciliation: sanitizedDailyAllocation(plan),
		predecessorManifestHash:
			plan.lineage?.manifestHash ||
			plan.backup?.manifest?.predecessorManifestHash,
		predecessorBackupSetSha256:
			plan.lineage?.backup?.backupSetSha256 ||
			plan.backup?.manifest?.predecessorBackupSetSha256,
		backupSetSha256: plan.backup?.backupSetSha256,
		fullDocumentCas: true,
		createsReservations: false,
		mutatesLifecycleGuestStayRoomAssignmentPaymentVccSettlementOrRoot: false,
		mutatesHotelRunnerEventMirrorPortalJobOrV1Artifacts: false,
		vendorApiCalls: 0,
	};
}

function sanitizedRollbackOutput(plan, mode, proof = "") {
	return {
		mode,
		action: "rollback",
		repairId: REPAIR_ID,
		releaseSha: plan.releaseSha,
		state: plan.state,
		proof:
			mode === "rollback_dry_run" && plan.state === "ready" ? proof : undefined,
		proofExpiresInMinutes:
			mode === "rollback_dry_run" && plan.state === "ready"
				? PROOF_MAX_AGE_MS / 60_000
				: undefined,
		planHash: plan.planHash,
		fromHash: plan.expectedHash,
		toV1BackupHash: plan.originalHash,
		backupSetSha256: plan.backup.backupSetSha256,
		predecessorManifestHash: plan.backup.manifest.predecessorManifestHash,
		fullDocumentCas: true,
		vendorApiCalls: 0,
	};
}

async function connectDatabase(database) {
	await mongoose.connect(database, {
		useNewUrlParser: true,
		useUnifiedTopology: true,
		autoIndex: false,
		autoCreate: false,
		readPreference: "primary",
	});
	return mongoose.connection.db;
}

async function main(
	argv = process.argv.slice(2),
	{
		clock = () => new Date(),
		connect = connectDatabase,
		disconnect = async () => mongoose.disconnect(),
		resolveReleaseSha = v1.currentReleaseSha,
		db: injectedDb = null,
	} = {}
) {
	const options = parseArguments(argv);
	const portalSelection = portalSelectionFromArguments(options);
	v1.assertRelease(options.releaseSha, resolveReleaseSha());
	const now = clock();
	const proofDetails = options.apply ? parseProof(options.proof, now) : null;
	const plannedAt = proofDetails?.plannedAt || now;
	const database =
		process.env.DATABASE || process.env.MONGO_URI || process.env.MONGODB_URI;
	if (!database && !injectedDb) {
		fail("Missing database connection string.", "EXPEDIA_V2_DATABASE_REQUIRED");
	}
	let db = injectedDb;
	let connectedHere = false;
	try {
		if (!db) {
			db = await connect(database);
			connectedHere = true;
		}
		if (options.rollback) {
			const plan = await loadRollbackPlan({
				db,
				releaseSha: options.releaseSha,
				plannedAt,
				portalSelection,
			});
			const generatedProof = rollbackProofToken(plan);
			if (
				options.apply &&
				(proofDetails.planHash !== plan.planHash ||
					options.proof !== generatedProof)
			) {
				fail(
					"Rollback scope no longer matches its proof.",
					"EXPEDIA_V2_PROOF_MISMATCH"
				);
			}
			console.log(
				JSON.stringify(
					sanitizedRollbackOutput(
						plan,
						options.apply ? "rollback_apply" : "rollback_dry_run",
						generatedProof
					),
					null,
					2
				)
			);
			if (!options.apply) {
				return { state: "rollback_dry_run_ready", plan, proof: generatedProof };
			}
			await v1.assertWritablePrimary(db);
			const result = await applyRollbackPlan({ db, plan });
			console.log(JSON.stringify(result, null, 2));
			return result;
		}
		const plan = await loadPlan({
			db,
			releaseSha: options.releaseSha,
			plannedAt,
			portalSelection,
		});
		if (plan.state === "already_applied") {
			console.log(
				JSON.stringify(sanitizedForwardOutput(plan, "already_applied"), null, 2)
			);
			return { state: "already_applied", plan, vendorApiCalls: 0 };
		}
		const generatedProof = proofToken(plan);
		if (
			options.apply &&
			(proofDetails.planHash !== plan.planHash ||
				options.proof !== generatedProof)
		) {
			fail(
				"The exact scope no longer matches the supplied proof.",
				"EXPEDIA_V2_PROOF_MISMATCH"
			);
		}
		console.log(
			JSON.stringify(
				sanitizedForwardOutput(
					plan,
					options.apply ? "apply" : "dry_run",
					generatedProof
				),
				null,
				2
			)
		);
		if (!options.apply) {
			return { state: "dry_run_ready", plan, proof: generatedProof };
		}
		await v1.assertWritablePrimary(db);
		const result = await applyRepairPlan({ db, plan });
		console.log(JSON.stringify(result, null, 2));
		return result;
	} finally {
		if (connectedHere) await disconnect();
	}
}

if (require.main === module) {
	main().catch((error) => {
		console.error("[expedia-commercial-materialization-v2] stopped", {
			code: clean(error?.code || "EXPEDIA_V2_REPAIR_FAILED").slice(0, 100),
		});
		process.exitCode = 1;
	});
}

module.exports = {
	BACKUP_COLLECTION,
	BACKUP_ROLES,
	COLLECTIONS,
	COLLECTOR_MAX_AGE_MS,
	MANIFEST_COLLECTION,
	PROOF_MAX_AGE_MS,
	REPAIR_ID,
	TARGET,
	allocateCentsByWeight,
	applyRepairPlan,
	applyRollbackPlan,
	assertExactV1PostState,
	assertFreshPortalEvidence,
	assertOperationallySafe,
	assertPostconditions,
	assertTrustedConversion,
	backupRecord,
	buildBackupRecords,
	buildCommercialEvidence,
	buildExpectedDocument,
	buildWeightedPricing,
	loadAndVerifyBackup,
	loadPlan,
	loadRawScope,
	loadRollbackPlan,
	loadV1Lineage,
	main,
	materializedPaymentSummary,
	parseArguments,
	parseProof,
	portalSelectionFromArguments,
	proofToken,
	protectedSnapshot,
	rollbackProofToken,
	sanitizedForwardOutput,
	sanitizedRollbackOutput,
	sourceSlots,
	verifyBackupRecords,
};
