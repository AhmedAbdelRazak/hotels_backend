/** @format */

"use strict";

// One-record, archive-only correction for the authenticated Airbnb reply
// thread that was misclassified as a new reservation on 2026-08-14.
//
// Dry-run (default):
//   node scripts/repairAirbnbGuestThreadDisposition20260814.js
//
// Apply the exact fresh proof emitted by dry-run:
//   node scripts/repairAirbnbGuestThreadDisposition20260814.js --apply \
//     --repair-id=airbnb-guest-thread-disposition-20260814-v1 \
//     --proof=<timestamp.sha256>
//
// This script never writes a Reservation and never deletes or replaces either
// archived body. The sole write is one versioned InboundEmail disposition CAS.

require("dotenv").config();

const crypto = require("node:crypto");
const mongoose = require("mongoose");

mongoose.set("strictQuery", true);

const InboundEmail = require("../models/inbound_email");
const Reservations = require("../models/reservations");
const {
	classifyOtaGuestCommunication,
} = require("../services/otaInboundCommunicationClassifier");
const {
	buildOtaConfirmationLookup,
} = require("../services/otaReservationMapper");

const REPAIR_ID = "airbnb-guest-thread-disposition-20260814-v1";
const PROOF_MAX_AGE_MS = 30 * 60 * 1000;
const PROOF_FUTURE_SKEW_MS = 5 * 1000;

const TARGET = Object.freeze({
	auditId: "6a7e66ea79505aeca6506d15",
	repairId: REPAIR_ID,
	provider: "airbnb",
	source: "sendgrid",
	subject:
		"RE: Reservation for خطوات للحرم الشريف - باص خاص - غرفة ثلاثى, Sep 1 – 6",
	falseConfirmation:
		"for خطوات للحرم الشريف - باص خاص - غرفة ثلاثى, sep 1 – 6",
	emailHash: "d950bdee3c64b911414fd0c12a451b4d9dccc26a51d141f112b97c5594a2fe7e",
	textHash: "98513e43755e0a9f8d0265b81658f3588cfa9b220179110513775e6b972ade2c",
	bodyHtmlHash:
		"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
	dedupeKey:
		"mid:234be78f122c9066387ab86353b67f02b88356a378407c53068faa0e645f246c",
	version: 0,
	createdAt: "2026-08-14T00:52:58.681Z",
	updatedAt: "2026-08-14T00:53:11.132Z",
	receivedAt: "2026-08-14T00:52:58.656Z",
	processedAt: "2026-08-14T00:53:10.808Z",
});

const sha256 = (value = "") =>
	crypto.createHash("sha256").update(String(value || "")).digest("hex");

const id = (value) => String(value?._id || value || "");
const iso = (value) => new Date(value).toISOString();

function fail(code, message) {
	const error = new Error(message);
	error.code = code;
	throw error;
}

function stableValue(value) {
	if (value instanceof Date) return value.toISOString();
	if (Array.isArray(value)) return value.map(stableValue);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, stableValue(value[key])]),
		);
	}
	return value;
}

function stableJson(value) {
	return JSON.stringify(stableValue(value));
}

function parseArguments(argv = process.argv.slice(2)) {
	const options = { apply: false, repairId: "", proof: "" };
	for (const argument of argv) {
		if (argument === "--apply") options.apply = true;
		else if (argument.startsWith("--repair-id=")) {
			if (options.repairId) {
				fail("AIRBNB_DISPOSITION_ARGUMENT_INVALID", "--repair-id may be supplied only once.");
			}
			options.repairId = argument.slice("--repair-id=".length).trim();
		} else if (argument.startsWith("--proof=")) {
			if (options.proof) {
				fail("AIRBNB_DISPOSITION_ARGUMENT_INVALID", "--proof may be supplied only once.");
			}
			options.proof = argument.slice("--proof=".length).trim().toLowerCase();
		} else {
			fail("AIRBNB_DISPOSITION_ARGUMENT_INVALID", `Unknown argument: ${argument}`);
		}
	}
	if (!options.apply && (options.repairId || options.proof)) {
		fail(
			"AIRBNB_DISPOSITION_ARGUMENT_INVALID",
			"--repair-id and --proof are accepted only with --apply.",
		);
	}
	if (options.apply && options.repairId !== REPAIR_ID) {
		fail(
			"AIRBNB_DISPOSITION_ARGUMENT_INVALID",
			`--apply requires --repair-id=${REPAIR_ID}.`,
		);
	}
	if (options.apply && !/^\d{13}\.[a-f0-9]{64}$/.test(options.proof)) {
		fail(
			"AIRBNB_DISPOSITION_ARGUMENT_INVALID",
			"--apply requires the exact fresh proof emitted by dry-run.",
		);
	}
	return options;
}

function parseProof(proof, now = new Date()) {
	const match = String(proof || "").match(/^(\d{13})\.([a-f0-9]{64})$/);
	if (!match) fail("AIRBNB_DISPOSITION_PROOF_INVALID", "Dry-run proof format is invalid.");
	const plannedAt = new Date(Number(match[1]));
	const age = now.getTime() - plannedAt.getTime();
	if (age > PROOF_MAX_AGE_MS || age < -PROOF_FUTURE_SKEW_MS) {
		fail("AIRBNB_DISPOSITION_PROOF_EXPIRED", "Dry-run proof is expired or from the future.");
	}
	return { plannedAt, scopeHash: match[2] };
}

function emailFromAudit(audit = {}) {
	return {
		from: audit.from || "",
		subject: audit.subject || "",
		text: audit.bodyText || "",
		html: audit.bodyHtml || "",
		provider: audit.provider || "",
		senderAuthentication: audit.senderAuthentication || {},
	};
}

function assertTargetBefore(audit, target = TARGET) {
	if (!audit) fail("AIRBNB_DISPOSITION_ARCHIVE_MISSING", "Pinned inbound archive is missing.");
	const exact = (actual, expected, label) => {
		if (String(actual ?? "") !== String(expected ?? "")) {
			fail("AIRBNB_DISPOSITION_ARCHIVE_CHANGED", `${label} changed from the pinned pre-repair state.`);
		}
	};
	exact(id(audit), target.auditId, "Archive ID");
	exact(audit.__v, target.version, "Archive version");
	exact(audit.source, target.source, "Archive source");
	exact(audit.provider, target.provider, "Archive provider");
	exact(audit.subject, target.subject, "Archive subject");
	exact(audit.confirmationNumber, target.falseConfirmation, "Historic AI identity");
	exact(audit.emailHash, target.emailHash, "Archive email hash");
	exact(audit.textHash, target.textHash, "Archive text hash");
	exact(audit.dedupeKey, target.dedupeKey, "Archive dedupe key");
	exact(iso(audit.createdAt), target.createdAt, "Archive creation time");
	exact(iso(audit.updatedAt), target.updatedAt, "Archive update time");
	exact(iso(audit.receivedAt), target.receivedAt, "Archive receipt time");
	exact(iso(audit.processedAt), target.processedAt, "Archive processing time");
	exact(audit.intent, "new_reservation", "Archive intent");
	exact(audit.eventType, "unknown", "Archive event type");
	exact(audit.processingStatus, "needs_mapping", "Archive processing status");
	exact(audit.automationAction, "skipped", "Archive automation action");
	exact(
		audit.skipReason,
		"ota_mapping_required_no_reservation_created",
		"Archive skip reason",
	);
	exact(audit.normalizedReservation?.intent, "new_reservation", "Normalized intent");
	exact(audit.normalizedReservation?.eventType, "unknown", "Normalized event type");
	exact(
		audit.normalizedReservation?.confirmationNumber,
		target.falseConfirmation,
		"Normalized historic AI identity",
	);
	exact(audit.reconciliation?.status, "needs_mapping", "Reconciliation status");
	exact(
		audit.reconciliation?.skipReason,
		"ota_mapping_required_no_reservation_created",
		"Reconciliation skip reason",
	);
	if (audit.duplicateOf != null) {
		fail("AIRBNB_DISPOSITION_ARCHIVE_CHANGED", "Target unexpectedly became a duplicate archive.");
	}
	if (audit.reservationMongoId != null || audit.hotelId != null || audit.hasReservationConnection === true) {
		fail("AIRBNB_DISPOSITION_RESERVATION_LINKED", "Target archive is linked to reservation data.");
	}
	if (audit.senderAuthentication?.authenticatedAligned !== true) {
		fail("AIRBNB_DISPOSITION_AUTH_CHANGED", "Aligned sender authentication is absent.");
	}
	exact(audit.senderAuthentication?.trustedProvider, "airbnb", "Trusted sender provider");
	exact(audit.senderAuthentication?.fromDomain, "airbnb.com", "Authenticated From domain");
	exact(audit.senderAuthentication?.method, "dkim", "Authentication method");
	if (!(audit.senderAuthentication?.alignedDkimPassDomains || []).includes("express.airbnb.com")) {
		fail("AIRBNB_DISPOSITION_AUTH_CHANGED", "Pinned aligned Airbnb DKIM domain is absent.");
	}
	if (sha256(audit.bodyText || "") !== target.textHash) {
		fail("AIRBNB_DISPOSITION_BODY_CHANGED", "Stored body text no longer matches its pinned hash.");
	}
	if (sha256(audit.bodyHtml || "") !== target.bodyHtmlHash) {
		fail("AIRBNB_DISPOSITION_BODY_CHANGED", "Stored body HTML no longer matches its pinned hash.");
	}
	if (audit.reconciliation?.dispositionRepair) {
		fail("AIRBNB_DISPOSITION_ALREADY_REPAIRED", "A disposition repair marker already exists.");
	}
}

function assertClassifierProof(audit) {
	const classification = classifyOtaGuestCommunication(emailFromAudit(audit));
	const expectedEvidence = [
		"authenticated_airbnb_sender",
		"reservation_thread_reply_subject_without_identity",
	];
	if (
		classification.matched !== true ||
		classification.terminalNonReservation !== true ||
		classification.isGuestCommunication !== true ||
		classification.suppressForwarding !== true ||
		classification.intent !== "not_reservation" ||
		classification.classification !== "guest_communication" ||
		classification.reason !== "airbnb_guest_message" ||
		classification.provider !== "airbnb" ||
		stableJson(classification.evidence || []) !== stableJson(expectedEvidence)
	) {
		fail(
			"AIRBNB_DISPOSITION_CLASSIFIER_NOT_PROVEN",
			"Current deterministic classifier does not prove the exact terminal Airbnb guest-message result.",
		);
	}
	return classification;
}

function reservationAbsenceQuery(audit, target = TARGET) {
	const identityLookup = buildOtaConfirmationLookup(
		target.falseConfirmation,
		target.provider,
	);
	if (!identityLookup?.$or?.length) {
		fail("AIRBNB_DISPOSITION_IDENTITY_INVALID", "Pinned historic identity is not queryable.");
	}
	const objectId = mongoose.Types.ObjectId.isValid(target.auditId)
		? new mongoose.Types.ObjectId(target.auditId)
		: target.auditId;
	return {
		$or: [
			...identityLookup.$or,
			{ "supplierData.otaInboundEmailId": { $in: [target.auditId, objectId] } },
			{ "supplierData.otaLastInboundEmailId": { $in: [target.auditId, objectId] } },
			{
				"supplierData.otaCommercialEvidence.inboundEmailId": {
					$in: [target.auditId, objectId],
				},
			},
			{ "otaPlatformReview.inboundEmailId": { $in: [target.auditId, objectId] } },
			{
				"otaPlatformReview.proposedInbound.inboundEmailId": {
					$in: [target.auditId, objectId],
				},
			},
			...(audit.reservationMongoId ? [{ _id: audit.reservationMongoId }] : []),
		],
	};
}

function dispositionSet(classification, plannedAt, target = TARGET) {
	const automationComment =
		"Authenticated Airbnb reply thread was deterministically classified as guest communication; no reservation was created or changed.";
	return {
		intent: "not_reservation",
		processingStatus: "not_reservation",
		automationAction: "skipped",
		skipReason: "airbnb_guest_message",
		automationComment,
		hasReservationConnection: false,
		matchedReservationBy: [],
		"normalizedReservation.intent": "not_reservation",
		"normalizedReservation.terminalNonReservation": true,
		"normalizedReservation.suppressForwarding": true,
		"normalizedReservation.skipReason": "airbnb_guest_message",
		"normalizedReservation.communicationClassification": classification,
		"reconciliation.status": "not_reservation",
		"reconciliation.actionTaken": "skipped",
		"reconciliation.skipReason": "airbnb_guest_message",
		"reconciliation.automationComment": automationComment,
		"reconciliation.dispositionRepair": {
			repairId: target.repairId,
			policyDate: "2026-08-14",
			appliedAt: new Date(plannedAt),
			priorStatus: "needs_mapping",
			priorIntent: "new_reservation",
			classifierReason: "airbnb_guest_message",
			classifierEvidence: [...classification.evidence],
			bodyPreserved: true,
			bodyTextHash: target.textHash,
			bodyHtmlHash: target.bodyHtmlHash,
			subjectHash: sha256(target.subject),
			reservationMutationCount: 0,
		},
	};
}

function casFilter(audit, target = TARGET) {
	return {
		_id: target.auditId,
		__v: target.version,
		createdAt: audit.createdAt,
		updatedAt: audit.updatedAt,
		receivedAt: audit.receivedAt,
		processedAt: audit.processedAt,
		source: target.source,
		provider: target.provider,
		subject: target.subject,
		from: audit.from,
		emailHash: target.emailHash,
		textHash: target.textHash,
		dedupeKey: target.dedupeKey,
		duplicateOf: null,
		bodyText: audit.bodyText,
		bodyHtml: audit.bodyHtml,
		confirmationNumber: target.falseConfirmation,
		intent: "new_reservation",
		eventType: "unknown",
		processingStatus: "needs_mapping",
		automationAction: "skipped",
		skipReason: "ota_mapping_required_no_reservation_created",
		hasReservationConnection: false,
		reservationMongoId: null,
		hotelId: null,
		"normalizedReservation.intent": "new_reservation",
		"normalizedReservation.eventType": "unknown",
		"normalizedReservation.confirmationNumber": target.falseConfirmation,
		"reconciliation.status": "needs_mapping",
		"reconciliation.skipReason": "ota_mapping_required_no_reservation_created",
		"reconciliation.dispositionRepair": { $exists: false },
		"senderAuthentication.authenticatedAligned": true,
		"senderAuthentication.trustedProvider": "airbnb",
		"senderAuthentication.fromDomain": "airbnb.com",
		"senderAuthentication.method": "dkim",
		"senderAuthentication.alignedDkimPassDomains": "express.airbnb.com",
	};
}

function planScope(plan) {
	return {
		repairId: plan.target.repairId,
		plannedAt: plan.plannedAt,
		action: plan.action,
		target: plan.target,
		archiveFacts: plan.archiveFacts,
		classification: plan.classification,
		reservationMatchCount: plan.reservationMatchCount,
		set: plan.set,
	};
}

function proofToken(plan) {
	const scopeHash = sha256(stableJson(planScope(plan)));
	return `${new Date(plan.plannedAt).getTime()}.${scopeHash}`;
}

function archiveFacts(audit) {
	return {
		auditId: id(audit),
		version: audit.__v,
		createdAt: iso(audit.createdAt),
		updatedAt: iso(audit.updatedAt),
		receivedAt: iso(audit.receivedAt),
		processedAt: iso(audit.processedAt),
		emailHash: audit.emailHash,
		textHash: audit.textHash,
		dedupeKey: audit.dedupeKey,
		subjectHash: sha256(audit.subject || ""),
		fromHash: sha256(audit.from || ""),
		bodyTextHash: sha256(audit.bodyText || ""),
		bodyHtmlHash: sha256(audit.bodyHtml || ""),
		processingStatus: audit.processingStatus,
		intent: audit.intent,
		normalizedIntent: audit.normalizedReservation?.intent || "",
		reservationMongoId: id(audit.reservationMongoId),
		hasReservationConnection: audit.hasReservationConnection === true,
	};
}

async function buildPlan(plannedAt = new Date(), dependencies, target = TARGET) {
	const deps = dependencies || defaultDependencies();
	const audit = await deps.findArchiveById(target.auditId);
	let classification;
	let action;
	let set;
	if (audit?.reconciliation?.dispositionRepair) {
		classification = assertClassifierProof(audit);
		const applied = assertTargetApplied(audit, classification, target);
		action = "already_applied_noop";
		set = applied.set;
	} else {
		assertTargetBefore(audit, target);
		classification = assertClassifierProof(audit);
		action = "apply_disposition";
		set = dispositionSet(classification, plannedAt, target);
	}
	const matchQuery = reservationAbsenceQuery(audit, target);
	const matches = await deps.findReservationMatches(matchQuery);
	if ((matches || []).length !== 0) {
		fail(
			"AIRBNB_DISPOSITION_RESERVATION_MATCHED",
			"A Reservation now matches the archive link or historic identity; archive-only repair refused.",
		);
	}
	const plan = {
		plannedAt: new Date(plannedAt),
		action,
		target: { ...target },
		audit,
		archiveFacts: archiveFacts(audit),
		classification,
		reservationMatchCount: 0,
		reservationQuery: matchQuery,
		set,
	};
	plan.proof = proofToken(plan);
	return plan;
}

function valueAtPath(object, path) {
	return String(path)
		.split(".")
		.reduce((value, key) => (value == null ? undefined : value[key]), object);
}

function assertTargetApplied(audit, classification, target = TARGET) {
	if (!audit) fail("AIRBNB_DISPOSITION_ARCHIVE_MISSING", "Pinned inbound archive is missing.");
	const marker = audit.reconciliation?.dispositionRepair;
	const appliedAt = new Date(marker?.appliedAt || "");
	if (!Number.isFinite(appliedAt.getTime())) {
		fail(
			"AIRBNB_DISPOSITION_APPLIED_STATE_INVALID",
			"The existing disposition marker has no valid application time.",
		);
	}
	const exact = (actual, expected, label) => {
		if (stableJson(actual) !== stableJson(expected)) {
			fail(
				"AIRBNB_DISPOSITION_APPLIED_STATE_INVALID",
				`${label} differs from the exact applied disposition.`,
			);
		}
	};
	exact(id(audit), target.auditId, "Archive ID");
	exact(Number(audit.__v), target.version + 1, "Archive version");
	exact(audit.source, target.source, "Archive source");
	exact(audit.provider, target.provider, "Archive provider");
	exact(audit.subject, target.subject, "Archive subject");
	exact(audit.confirmationNumber, target.falseConfirmation, "Historic AI identity");
	exact(audit.emailHash, target.emailHash, "Archive email hash");
	exact(audit.textHash, target.textHash, "Archive text hash");
	exact(audit.dedupeKey, target.dedupeKey, "Archive dedupe key");
	exact(iso(audit.createdAt), target.createdAt, "Archive creation time");
	exact(iso(audit.receivedAt), target.receivedAt, "Archive receipt time");
	exact(iso(audit.processedAt), target.processedAt, "Archive processing time");
	exact(audit.eventType, "unknown", "Archive event type");
	exact(audit.normalizedReservation?.eventType, "unknown", "Normalized event type");
	exact(
		audit.normalizedReservation?.confirmationNumber,
		target.falseConfirmation,
		"Normalized historic AI identity",
	);
	if (
		audit.duplicateOf != null ||
		audit.reservationMongoId != null ||
		audit.hotelId != null
	) {
		fail(
			"AIRBNB_DISPOSITION_APPLIED_STATE_INVALID",
			"The applied archive gained a duplicate or Reservation link.",
		);
	}
	if (
		audit.senderAuthentication?.authenticatedAligned !== true ||
		audit.senderAuthentication?.trustedProvider !== "airbnb" ||
		audit.senderAuthentication?.fromDomain !== "airbnb.com" ||
		audit.senderAuthentication?.method !== "dkim" ||
		!(audit.senderAuthentication?.alignedDkimPassDomains || []).includes(
			"express.airbnb.com",
		)
	) {
		fail(
			"AIRBNB_DISPOSITION_AUTH_CHANGED",
			"The applied archive no longer has the exact authenticated Airbnb proof.",
		);
	}
	if (
		sha256(audit.bodyText || "") !== target.textHash ||
		sha256(audit.bodyHtml || "") !== target.bodyHtmlHash
	) {
		fail(
			"AIRBNB_DISPOSITION_BODY_CHANGED",
			"The applied archive body no longer matches the pinned evidence.",
		);
	}
	const expectedSet = dispositionSet(classification, appliedAt, target);
	for (const [path, expected] of Object.entries(expectedSet)) {
		exact(valueAtPath(audit, path), expected, `Applied field ${path}`);
	}
	return { appliedAt, set: expectedSet };
}

function assertFinal(plan, finalAudit) {
	if (!finalAudit) fail("AIRBNB_DISPOSITION_POSTCONDITION_FAILED", "Final archive is missing.");
	if (id(finalAudit) !== plan.target.auditId || Number(finalAudit.__v) !== plan.target.version + 1) {
		fail("AIRBNB_DISPOSITION_POSTCONDITION_FAILED", "Final archive identity/version is invalid.");
	}
	for (const [path, expected] of Object.entries(plan.set)) {
		const actual = valueAtPath(finalAudit, path);
		if (stableJson(actual) !== stableJson(expected)) {
			fail("AIRBNB_DISPOSITION_POSTCONDITION_FAILED", `Final field ${path} differs from the proof.`);
		}
	}
	for (const [field, expected] of [
		["bodyText", plan.archiveFacts.bodyTextHash],
		["bodyHtml", plan.archiveFacts.bodyHtmlHash],
		["subject", plan.archiveFacts.subjectHash],
	]) {
		if (sha256(finalAudit[field] || "") !== expected) {
			fail("AIRBNB_DISPOSITION_BODY_CHANGED", `Final ${field} was not preserved.`);
		}
	}
	if (
		finalAudit.emailHash !== plan.target.emailHash ||
		finalAudit.textHash !== plan.target.textHash ||
		finalAudit.dedupeKey !== plan.target.dedupeKey ||
		finalAudit.confirmationNumber !== plan.target.falseConfirmation ||
		iso(finalAudit.processedAt) !== plan.target.processedAt ||
		finalAudit.reservationMongoId != null ||
		finalAudit.hotelId != null
	) {
		fail("AIRBNB_DISPOSITION_POSTCONDITION_FAILED", "An immutable archive or reservation-link field changed.");
	}
	assertTargetApplied(finalAudit, plan.classification, plan.target);
}

async function applyPlan(plan, dependencies, target = TARGET) {
	const deps = dependencies || defaultDependencies();
	const verifyApplied = async () => {
		const finalAudit = await deps.findArchiveById(target.auditId);
		assertFinal(plan, finalAudit);
		const finalMatches = await deps.findReservationMatches(
			reservationAbsenceQuery(finalAudit, target),
		);
		if ((finalMatches || []).length !== 0) {
			fail(
				"AIRBNB_DISPOSITION_POSTCONDITION_FAILED",
				"A Reservation appeared during archive finalization.",
			);
		}
		return finalAudit;
	};

	if (plan.action === "already_applied_noop") {
		return {
			finalAudit: await verifyApplied(),
			action: "already_applied_noop",
			reservationMutationCount: 0,
		};
	}
	if (plan.action !== "apply_disposition") {
		fail(
			"AIRBNB_DISPOSITION_PLAN_INVALID",
			"The proof-bound repair action is invalid.",
		);
	}

	let write = null;
	let writeError = null;
	try {
		write = await deps.casArchive(
			casFilter(plan.audit, target),
			{ $set: plan.set, $inc: { __v: 1 } },
			{ writeConcern: { w: "majority" }, timestamps: true },
		);
	} catch (error) {
		writeError = error;
	}
	const matched = Number(write?.matchedCount ?? write?.n ?? 0);
	const modified = Number(write?.modifiedCount ?? write?.nModified ?? 0);
	if (writeError || matched !== 1 || modified !== 1) {
		try {
			return {
				finalAudit: await verifyApplied(),
				action: "lost_ack_recovered",
				reservationMutationCount: 0,
			};
		} catch (_verificationError) {
			if (writeError) throw writeError;
			fail(
				"AIRBNB_DISPOSITION_CAS_LOST",
				"Archive CAS did not produce the exact proof-bound disposition; no second mutation was attempted.",
			);
		}
	}
	return {
		finalAudit: await verifyApplied(),
		action: "applied",
		reservationMutationCount: 0,
	};
}

function safeOutput(plan, mode = "dry-run", applied = false) {
	return {
		mode,
		repairId: plan.target.repairId,
		auditId: plan.target.auditId,
		proof: plan.proof,
		proofExpiresInMinutes: PROOF_MAX_AGE_MS / 60000,
		authenticatedAlignedAirbnb: true,
		classifierResult: {
			intent: plan.classification.intent,
			reason: plan.classification.reason,
			evidence: plan.classification.evidence,
		},
		currentProcessingStatus: plan.archiveFacts.processingStatus,
		currentReservationMatchCount: plan.reservationMatchCount,
		action: plan.action,
		plannedArchiveWriteCount: plan.action === "already_applied_noop" ? 0 : 1,
		plannedReservationWriteCount: 0,
		bodyTextPreserved: true,
		bodyHtmlPreserved: true,
		applied,
		applyCommand:
			mode === "dry-run"
				? `node scripts/repairAirbnbGuestThreadDisposition20260814.js --apply --repair-id=${plan.target.repairId} --proof=${plan.proof}`
				: undefined,
	};
}

function defaultDependencies() {
	return {
		findArchiveById: (auditId) => InboundEmail.findById(auditId).lean().exec(),
		findReservationMatches: (query) =>
			Reservations.find(query).select("_id").limit(2).lean().exec(),
		casArchive: (filter, update, options) =>
			InboundEmail.updateOne(filter, update, options),
	};
}

async function run(options = parseArguments(), dependencies) {
	const now = new Date();
	const proof = options.apply ? parseProof(options.proof, now) : null;
	const plan = await buildPlan(proof?.plannedAt || now, dependencies, TARGET);
	if (options.apply && plan.proof !== options.proof) {
		fail(
			"AIRBNB_DISPOSITION_PLAN_CHANGED",
			"Live archive/classifier/reservation scope differs from the reviewed dry-run proof.",
		);
	}
	if (!options.apply) return safeOutput(plan, "dry-run", false);
	const result = await applyPlan(plan, dependencies, TARGET);
	return {
		...safeOutput(plan, "apply", true),
		resultAction: result.action,
	};
}

async function main() {
	const database = process.env.DATABASE || process.env.MONGO_URI || process.env.MONGODB_URI;
	if (!database) fail("AIRBNB_DISPOSITION_DATABASE_MISSING", "Missing MongoDB connection string.");
	await mongoose.connect(database, { autoIndex: false });
	const output = await run(parseArguments());
	console.log(JSON.stringify(output, null, 2));
}

if (require.main === module) {
	main()
		.catch((error) => {
			console.error(`${error.code || "AIRBNB_DISPOSITION_FAILED"}: ${error.message}`);
			process.exitCode = 1;
		})
		.finally(async () => {
			if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
		});
}

module.exports = {
	PROOF_FUTURE_SKEW_MS,
	PROOF_MAX_AGE_MS,
	REPAIR_ID,
	TARGET,
	applyPlan,
	archiveFacts,
	assertClassifierProof,
	assertFinal,
	assertTargetBefore,
	buildPlan,
	casFilter,
	dispositionSet,
	emailFromAudit,
	parseArguments,
	parseProof,
	proofToken,
	reservationAbsenceQuery,
	run,
	safeOutput,
	sha256,
	stableJson,
};
