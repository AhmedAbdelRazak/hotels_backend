/** @format */

"use strict";

/**
 * One-time, fail-closed queue recovery for the four HotelRunner reservations
 * blocked by the 2026-08-10 stale room-list generation incident.
 *
 * This script intentionally does NOT update HotelRunner events or mirrors and
 * never reads or writes the PMS reservation collection. A later successful
 * published room-list generation owns stale-event requeueing. This script only
 * makes the four exact direct-OTA fallback job/audit pairs active again, with a
 * short hold so the room refresh and event projection can finish first.
 *
 * Dry run (default):
 *   node scripts/recoverHotelRunnerStaleMappingEvents20260810.js
 *
 * Apply using a transaction on replica set/mongos, or serialized exact-CAS
 * writes with compensation on a positively identified standalone primary:
 *   node scripts/recoverHotelRunnerStaleMappingEvents20260810.js --apply \
 *     --repair-id=hotelrunner-stale-mapping-events-20260810-v1
 *
 * Verify after apply, after room-list publication, and again after fallback
 * finalization:
 *   node scripts/recoverHotelRunnerStaleMappingEvents20260810.js --postconditions
 */

const path = require("path");
const crypto = require("node:crypto");

require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const mongoose = require("mongoose");
const BSON = require("bson");
const {
	canonicalEjsonSha256,
	cloneBson,
} = require("../services/tripHotelRunnerRepair20260805");

mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);

const RECOVERY_ID = "hotelrunner-stale-mapping-events-20260810-v1";
const HOTEL_ID = "6a40b6a1a6efe70450536038";
const RECOVERY_HOLD_MS = 30 * 60 * 1000;
const REOPEN_DECISION =
	"incident_reopened_for_published_mapping_refresh_20260810";
const TERMINAL_DECISION = "hotelrunner_local_state_needs_review";
const TERMINAL_CODE = "HOTELRUNNER_LOCAL_RECORD_BLOCKED";
const STALE_MAPPING_CODE = "hotelrunner_room_mapping_stale";
const TERMINAL_MESSAGE =
	"HotelRunner evidence exists but cannot be selected safely; email fallback was not allowed.";
const AWAITING_MESSAGE =
	"Authenticated direct-OTA reservation was archived for HotelRunner-first processing.";
const TRANSACTION_APPLY_STRATEGY = "snapshot_transaction";
const STANDALONE_APPLY_STRATEGY = "serialized_full_document_cas";
const SERIAL_LEASE_MS = 5 * 60 * 1000;

const COLLECTION_NAMES = Object.freeze({
	events: "hotelrunnerevents",
	mirrors: "hotelrunnerreservations",
	jobs: "hotelrunnerotafallbackjobs",
	audits: "inboundemails",
});

const TARGETS = Object.freeze(
	[
		{
			key: "agoda_688185991",
			provider: "agoda",
			confirmationNumber: "688185991",
			hotelRunnerReservationId: "40394769",
			hrNumber: "R004776657",
			channel: "agodaycs5",
			staleInvCode: "HR:1332587",
			eventId: "6a798f9ad8cbed2f4bad4752",
			mirrorId: "6a798f9b4d62ce1e740a7b07",
			jobId: "6a798f54d8cbed2f4bad4751",
			auditId: "6a798f51427e3b7cd6f0e119",
			eventReceivedAt: "2026-08-10T08:45:14.257Z",
			eventSourceUpdatedAt: "2026-08-10T08:45:13.000Z",
			eventUpdatedAt: "2026-08-10T08:45:19.185Z",
			terminalAt: "2026-08-10T08:47:02.405Z",
			jobUpdatedAt: "2026-08-10T08:47:02.417Z",
			auditUpdatedAt: "2026-08-10T08:47:02.411Z",
		},
		{
			key: "trip_1567953998411879",
			provider: "trip",
			confirmationNumber: "1567953998411879",
			hotelRunnerReservationId: "40396370",
			hrNumber: "R292705212",
			channel: "tripcom",
			staleInvCode: "HR:1332587",
			eventId: "6a79a193d8cbed2f4bad4754",
			mirrorId: "6a79a1934d62ce1e740aa71e",
			jobId: "6a79a192d8cbed2f4bad4753",
			auditId: "6a79a18f427e3b7cd6f0f901",
			eventReceivedAt: "2026-08-10T10:01:55.123Z",
			eventSourceUpdatedAt: "2026-08-10T10:01:53.000Z",
			eventUpdatedAt: "2026-08-10T10:01:59.228Z",
			terminalAt: "2026-08-10T10:04:51.963Z",
			jobUpdatedAt: "2026-08-10T10:04:51.975Z",
			auditUpdatedAt: "2026-08-10T10:04:51.969Z",
		},
		{
			key: "agoda_2040072127",
			provider: "agoda",
			confirmationNumber: "2040072127",
			hotelRunnerReservationId: "40397777",
			hrNumber: "R372544069",
			channel: "agodaycs5",
			staleInvCode: "HR:1332585",
			eventId: "6a79b035d8cbed2f4bad4756",
			mirrorId: "6a79b0364d62ce1e740acb0b",
			jobId: "6a79afe6d8cbed2f4bad4755",
			auditId: "6a79afe3427e3b7cd6f1100b",
			eventReceivedAt: "2026-08-10T11:04:21.578Z",
			eventSourceUpdatedAt: "2026-08-10T11:04:19.000Z",
			eventUpdatedAt: "2026-08-10T11:04:27.127Z",
			terminalAt: "2026-08-10T11:06:00.236Z",
			jobUpdatedAt: "2026-08-10T11:06:00.247Z",
			auditUpdatedAt: "2026-08-10T11:06:00.242Z",
		},
		{
			key: "agoda_2040125230",
			provider: "agoda",
			confirmationNumber: "2040125230",
			hotelRunnerReservationId: "40402350",
			hrNumber: "R481044036",
			channel: "agodaycs5",
			staleInvCode: "HR:1332547",
			eventId: "6a79e024d8cbed2f4bad475b",
			mirrorId: "6a79e0254d62ce1e740b4123",
			jobId: "6a79dfccd8cbed2f4bad475a",
			auditId: "6a79dfc9427e3b7cd6f14eb9",
			eventReceivedAt: "2026-08-10T14:28:52.375Z",
			eventSourceUpdatedAt: "2026-08-10T14:28:20.000Z",
			eventUpdatedAt: "2026-08-10T14:28:56.748Z",
			terminalAt: "2026-08-10T14:30:22.764Z",
			jobUpdatedAt: "2026-08-10T14:30:22.776Z",
			auditUpdatedAt: "2026-08-10T14:30:22.770Z",
		},
	].map((target) =>
		Object.freeze({
			...target,
			hotelId: HOTEL_ID,
			identityKey: `${target.provider}:${target.confirmationNumber}`,
		})
	)
);

class RecoveryError extends Error {
	constructor(message, code = "HOTELRUNNER_STALE_MAPPING_RECOVERY_FAILED") {
		super(message);
		this.name = "RecoveryError";
		this.code = code;
	}
}

const fail = (message, code) => {
	throw new RecoveryError(message, code);
};

const lower = (value) =>
	String(value ?? "")
		.trim()
		.toLowerCase();
const clean = (value) => String(value ?? "").trim();
const id = (value) => clean(value?._id || value).toLowerCase();
const oid = (value) => new mongoose.Types.ObjectId(clean(value));
const validObjectId = (value) => mongoose.Types.ObjectId.isValid(id(value));
const validSha256 = (value) => /^[a-f0-9]{64}$/i.test(clean(value));
const emptyReference = (value) => !id(value);
const dateMs = (value) => {
	const parsed = value instanceof Date ? value : new Date(value);
	return Number.isFinite(parsed.getTime()) ? parsed.getTime() : NaN;
};
const sameDate = (value, expected) => dateMs(value) === dateMs(expected);
const exactArray = (value, expected) =>
	Array.isArray(value) &&
	value.length === expected.length &&
	value.every((entry, index) => clean(entry) === clean(expected[index]));

// A full-document standalone rollback must retain BSON numeric and binary
// types. The repair helper's normal operational clone intentionally promotes
// numbers, so whole-document snapshots use a BSON byte round trip instead.
const cloneFullBson = (value) =>
	BSON.deserialize(BSON.serialize({ value }, { ignoreUndefined: false }), {
		promoteBuffers: false,
		promoteLongs: false,
		promoteValues: false,
	}).value;

const getDocumentPath = (document, dotted) =>
	String(dotted)
		.split(".")
		.reduce((value, key) => value?.[key], document);

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

function applyRecoveryUpdateToDocument(original, update) {
	const document = cloneFullBson(original);
	for (const [key, value] of Object.entries(update.$set || {})) {
		setDocumentPath(document, key, value);
	}
	for (const key of Object.keys(update.$unset || {})) {
		unsetDocumentPath(document, key);
	}
	for (const [key, instruction] of Object.entries(update.$push || {})) {
		const current = Array.isArray(getDocumentPath(document, key))
			? [...getDocumentPath(document, key)]
			: [];
		const additions = Array.isArray(instruction?.$each)
			? instruction.$each
			: [instruction];
		current.push(...cloneFullBson(additions));
		const sliced = Number.isInteger(instruction?.$slice)
			? instruction.$slice < 0
				? current.slice(instruction.$slice)
				: current.slice(0, instruction.$slice)
			: current;
		setDocumentPath(document, key, sliced);
	}
	for (const [key, increment] of Object.entries(update.$inc || {})) {
		setDocumentPath(
			document,
			key,
			Number(getDocumentPath(document, key) || 0) + Number(increment)
		);
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

const newSerialRunId = () => crypto.randomBytes(16).toString("hex");
const validSerialRunId = (value) => /^[a-f0-9]{32}$/.test(clean(value));

function parseArguments(argv = []) {
	const options = {
		apply: false,
		postconditions: false,
		help: false,
		repairId: "",
	};
	for (const argument of argv) {
		if (argument === "--apply") options.apply = true;
		else if (argument === "--postconditions") options.postconditions = true;
		else if (argument === "--help" || argument === "-h") options.help = true;
		else if (argument.startsWith("--repair-id=")) {
			if (options.repairId) {
				fail(
					"--repair-id may only be supplied once.",
					"HOTELRUNNER_STALE_MAPPING_RECOVERY_ARGUMENT_INVALID"
				);
			}
			options.repairId = clean(argument.slice("--repair-id=".length));
		} else {
			fail(
				`Unknown argument: ${argument}`,
				"HOTELRUNNER_STALE_MAPPING_RECOVERY_ARGUMENT_INVALID"
			);
		}
	}
	if (options.apply && options.postconditions) {
		fail(
			"--apply and --postconditions are mutually exclusive.",
			"HOTELRUNNER_STALE_MAPPING_RECOVERY_MODE_CONFLICT"
		);
	}
	if (options.apply && options.repairId !== RECOVERY_ID) {
		fail(
			`--apply requires --repair-id=${RECOVERY_ID}.`,
			"HOTELRUNNER_STALE_MAPPING_RECOVERY_REPAIR_ID_REQUIRED"
		);
	}
	if (!options.apply && options.repairId) {
		fail(
			"--repair-id is accepted only with --apply.",
			"HOTELRUNNER_STALE_MAPPING_RECOVERY_REPAIR_ID_UNEXPECTED"
		);
	}
	return options;
}

function collectionsFromDb(db) {
	return {
		events: db.collection(COLLECTION_NAMES.events),
		mirrors: db.collection(COLLECTION_NAMES.mirrors),
		jobs: db.collection(COLLECTION_NAMES.jobs),
		audits: db.collection(COLLECTION_NAMES.audits),
	};
}

async function loadTargetScope(
	collections,
	target,
	session = null,
	readOptions = null
) {
	const option =
		session || readOptions
			? { ...(readOptions || {}), ...(session ? { session } : {}) }
			: undefined;
	if (session) {
		const event = await collections.events.findOne(
			{ _id: oid(target.eventId) },
			option
		);
		const mirror = await collections.mirrors.findOne(
			{ _id: oid(target.mirrorId) },
			option
		);
		const job = await collections.jobs.findOne(
			{ _id: oid(target.jobId) },
			option
		);
		const audit = await collections.audits.findOne(
			{ _id: oid(target.auditId) },
			option
		);
		return { target, event, mirror, job, audit };
	}
	const [event, mirror, job, audit] = await Promise.all([
		collections.events.findOne({ _id: oid(target.eventId) }, option),
		collections.mirrors.findOne({ _id: oid(target.mirrorId) }, option),
		collections.jobs.findOne({ _id: oid(target.jobId) }, option),
		collections.audits.findOne({ _id: oid(target.auditId) }, option),
	]);
	return { target, event, mirror, job, audit };
}

async function loadScopes(collections, session = null, readOptions = null) {
	if (session) {
		const scopes = [];
		for (const target of TARGETS) {
			scopes.push(
				await loadTargetScope(collections, target, session, readOptions)
			);
		}
		return scopes;
	}
	return Promise.all(
		TARGETS.map((target) =>
			loadTargetScope(collections, target, session, readOptions)
		)
	);
}

function mismatch(list, condition, label) {
	if (!condition) list.push(label);
}

function identityMismatches(scope) {
	const { target, event, mirror, job, audit } = scope;
	const errors = [];
	for (const [role, document] of Object.entries({
		event,
		mirror,
		job,
		audit,
	})) {
		mismatch(errors, Boolean(document), `${role}.missing`);
	}
	if (errors.length) return errors;

	mismatch(errors, id(event._id) === target.eventId, "event._id");
	mismatch(errors, id(mirror._id) === target.mirrorId, "mirror._id");
	mismatch(errors, id(job._id) === target.jobId, "job._id");
	mismatch(errors, id(audit._id) === target.auditId, "audit._id");
	for (const [role, document] of Object.entries({
		event,
		mirror,
		job,
		audit,
	})) {
		mismatch(
			errors,
			id(document.hotelId) === target.hotelId,
			`${role}.hotelId`
		);
	}
	mismatch(
		errors,
		clean(event.hotelRunnerReservationId) === target.hotelRunnerReservationId,
		"event.hotelRunnerReservationId"
	);
	mismatch(
		errors,
		clean(mirror.hotelRunnerReservationId) === target.hotelRunnerReservationId,
		"mirror.hotelRunnerReservationId"
	);
	mismatch(errors, clean(event.hrNumber) === target.hrNumber, "event.hrNumber");
	mismatch(
		errors,
		clean(mirror.hrNumber) === target.hrNumber,
		"mirror.hrNumber"
	);
	mismatch(
		errors,
		clean(event.providerNumber) === target.confirmationNumber,
		"event.providerNumber"
	);
	mismatch(
		errors,
		clean(mirror.providerNumber) === target.confirmationNumber,
		"mirror.providerNumber"
	);
	mismatch(errors, lower(event.channel) === target.channel, "event.channel");
	mismatch(errors, lower(mirror.channel) === target.channel, "mirror.channel");
	mismatch(errors, lower(job.provider) === target.provider, "job.provider");
	mismatch(
		errors,
		lower(job.confirmationNumber) === lower(target.confirmationNumber),
		"job.confirmationNumber"
	);
	mismatch(
		errors,
		lower(job.identityKey) === target.identityKey,
		"job.identityKey"
	);
	mismatch(
		errors,
		id(job.inboundEmailId) === target.auditId,
		"job.inboundEmailId"
	);
	mismatch(errors, lower(audit.provider) === target.provider, "audit.provider");
	mismatch(
		errors,
		lower(audit.confirmationNumber) === lower(target.confirmationNumber),
		"audit.confirmationNumber"
	);
	mismatch(errors, lower(audit.intent) === "new_reservation", "audit.intent");
	mismatch(errors, lower(audit.eventType) === "new", "audit.eventType");
	mismatch(
		errors,
		id(audit.hotelRunnerFirstFallback?.jobId) === target.jobId,
		"audit.hotelRunnerFirstFallback.jobId"
	);
	mismatch(errors, validSha256(job.inboundEmailHash), "job.inboundEmailHash");
	mismatch(errors, validSha256(audit.emailHash), "audit.emailHash");
	mismatch(
		errors,
		lower(job.inboundEmailHash) === lower(audit.emailHash),
		"job/audit.emailHash"
	);
	mismatch(
		errors,
		validSha256(job.archiveFingerprint),
		"job.archiveFingerprint"
	);
	mismatch(
		errors,
		validSha256(job.normalizedReservationHash),
		"job.normalizedReservationHash"
	);
	mismatch(
		errors,
		validSha256(job.resolvedHotelProofHash),
		"job.resolvedHotelProofHash"
	);
	mismatch(errors, job.identityConflict !== true, "job.identityConflict");
	mismatch(
		errors,
		audit.senderAuthentication?.authenticatedAligned === true,
		"audit.senderAuthentication.authenticatedAligned"
	);
	mismatch(
		errors,
		lower(audit.senderAuthentication?.trustedProvider) === target.provider,
		"audit.senderAuthentication.trustedProvider"
	);
	const normalized = audit.normalizedReservation || {};
	mismatch(
		errors,
		lower(normalized.provider) === target.provider,
		"normalized.provider"
	);
	mismatch(
		errors,
		lower(normalized.confirmationNumber || normalized.reservationId) ===
			lower(target.confirmationNumber),
		"normalized.confirmationNumber"
	);
	mismatch(
		errors,
		lower(normalized.intent) === "new_reservation",
		"normalized.intent"
	);
	mismatch(
		errors,
		lower(normalized.eventType) === "new",
		"normalized.eventType"
	);
	mismatch(
		errors,
		id(normalized.inboundEmailId) === target.auditId,
		"normalized.inboundEmailId"
	);
	mismatch(
		errors,
		normalized.sourceSenderAuthenticated === true &&
			normalized.sourceSenderTrusted === true,
		"normalized.senderTrust"
	);
	mismatch(
		errors,
		lower(normalized.trustedTransportProvider) === target.provider,
		"normalized.trustedTransportProvider"
	);
	mismatch(
		errors,
		normalized.sourcePresence?.hotelName === true &&
			normalized.sourcePresence?.roomName === true &&
			normalized.sourcePresence?.checkinDate === true &&
			normalized.sourcePresence?.checkoutDate === true &&
			normalized.sourcePresence?.roomCount === true &&
			normalized.sourcePresence?.amount === true,
		"normalized.sourcePresence"
	);
	return errors;
}

function staleEvidenceMismatches(scope) {
	const { target, event, mirror } = scope;
	const errors = [];
	mismatch(errors, lower(event.status) === "needs_mapping", "event.status");
	mismatch(errors, Number(event.attempts) === 1, "event.attempts");
	mismatch(
		errors,
		lower(event.errorCode) === STALE_MAPPING_CODE,
		"event.errorCode"
	);
	mismatch(
		errors,
		emptyReference(event.reservationMongoId),
		"event.reservationMongoId"
	);
	mismatch(errors, id(event.mirrorId) === target.mirrorId, "event.mirrorId");
	mismatch(
		errors,
		sameDate(event.receivedAt, target.eventReceivedAt),
		"event.receivedAt"
	);
	mismatch(
		errors,
		sameDate(event.sourceUpdatedAt, target.eventSourceUpdatedAt),
		"event.sourceUpdatedAt"
	);
	mismatch(
		errors,
		sameDate(event.updatedAt, target.eventUpdatedAt),
		"event.updatedAt"
	);
	mismatch(
		errors,
		lower(event.result?.status) === "needs_mapping",
		"event.result.status"
	);
	mismatch(
		errors,
		lower(event.result?.code) === STALE_MAPPING_CODE,
		"event.result.code"
	);
	mismatch(
		errors,
		exactArray(event.result?.staleInvCodes, [target.staleInvCode]),
		"event.result.staleInvCodes"
	);
	mismatch(
		errors,
		exactArray(event.result?.missingInvCodes, [target.staleInvCode]),
		"event.result.missingInvCodes"
	);
	mismatch(
		errors,
		lower(mirror.projectionStatus) === "needs_mapping",
		"mirror.projectionStatus"
	);
	mismatch(
		errors,
		lower(mirror.lastErrorCode) === STALE_MAPPING_CODE,
		"mirror.lastErrorCode"
	);
	mismatch(
		errors,
		emptyReference(mirror.reservationMongoId),
		"mirror.reservationMongoId"
	);
	return errors;
}

function requeuedProjectionMismatches(scope) {
	const { target, event, mirror } = scope;
	const errors = [];
	mismatch(errors, lower(event.status) === "pending", "event.status");
	mismatch(errors, Number(event.attempts) === 0, "event.attempts");
	mismatch(
		errors,
		!clean(event.errorCode) && !clean(event.errorMessage),
		"event.lastError"
	);
	mismatch(
		errors,
		Number.isFinite(dateMs(event.nextAttemptAt)),
		"event.nextAttemptAt"
	);
	mismatch(
		errors,
		!clean(event.leaseOwner) &&
			!dateMs(event.leaseAcquiredAt) &&
			!dateMs(event.leaseUntil),
		"event.lease"
	);
	mismatch(
		errors,
		emptyReference(event.reservationMongoId),
		"event.reservationMongoId"
	);
	mismatch(errors, id(event.mirrorId) === target.mirrorId, "event.mirrorId");
	mismatch(
		errors,
		sameDate(event.receivedAt, target.eventReceivedAt),
		"event.receivedAt"
	);
	mismatch(
		errors,
		sameDate(event.sourceUpdatedAt, target.eventSourceUpdatedAt),
		"event.sourceUpdatedAt"
	);
	mismatch(
		errors,
		lower(event.result?.status) === "needs_mapping",
		"event.result.status"
	);
	mismatch(
		errors,
		lower(event.result?.code) === STALE_MAPPING_CODE,
		"event.result.code"
	);
	mismatch(
		errors,
		exactArray(event.result?.staleInvCodes, [target.staleInvCode]),
		"event.result.staleInvCodes"
	);
	mismatch(
		errors,
		exactArray(event.result?.missingInvCodes, [target.staleInvCode]),
		"event.result.missingInvCodes"
	);
	mismatch(
		errors,
		lower(mirror.projectionStatus) === "needs_mapping",
		"mirror.projectionStatus"
	);
	mismatch(
		errors,
		lower(mirror.lastErrorCode) === STALE_MAPPING_CODE,
		"mirror.lastErrorCode"
	);
	mismatch(
		errors,
		emptyReference(mirror.reservationMongoId),
		"mirror.reservationMongoId"
	);
	return errors;
}

function terminalLifecycleMismatches(scope) {
	const { target, job, audit } = scope;
	const errors = [];
	mismatch(errors, Number(job.__v || 0) === 0, "job.__v");
	mismatch(errors, lower(job.status) === "needs_review", "job.status");
	mismatch(errors, Number(job.attemptCount) === 1, "job.attemptCount");
	mismatch(
		errors,
		lower(job.lastDecision) === TERMINAL_DECISION,
		"job.lastDecision"
	);
	mismatch(
		errors,
		clean(job.lastErrorCode) === TERMINAL_CODE,
		"job.lastErrorCode"
	);
	mismatch(
		errors,
		clean(job.lastErrorMessage) === TERMINAL_MESSAGE,
		"job.lastErrorMessage"
	);
	mismatch(
		errors,
		sameDate(job.completedAt, target.terminalAt),
		"job.completedAt"
	);
	mismatch(
		errors,
		sameDate(job.inboundAuditFinalizedAt, target.terminalAt),
		"job.inboundAuditFinalizedAt"
	);
	mismatch(
		errors,
		sameDate(job.updatedAt, target.jobUpdatedAt),
		"job.updatedAt"
	);
	mismatch(
		errors,
		lower(job.inboundAuditFinalizationStatus) === "completed",
		"job.inboundAuditFinalizationStatus"
	);
	mismatch(
		errors,
		lower(job.ingressDecision?.status) === "api_observed",
		"job.ingressDecision.status"
	);
	mismatch(
		errors,
		Number(job.ingressDecision?.apiObservationCount) === 1,
		"job.ingressDecision.apiObservationCount"
	);
	mismatch(
		errors,
		sameDate(job.ingressDecision?.apiObservedAt, target.eventReceivedAt),
		"job.ingressDecision.apiObservedAt"
	);
	mismatch(
		errors,
		emptyReference(job.reservationMongoId),
		"job.reservationMongoId"
	);
	mismatch(
		errors,
		emptyReference(job.hotelRunnerEventId),
		"job.hotelRunnerEventId"
	);
	mismatch(
		errors,
		emptyReference(job.hotelRunnerMirrorId),
		"job.hotelRunnerMirrorId"
	);
	mismatch(
		errors,
		!clean(job.pendingTerminalStatus),
		"job.pendingTerminalStatus"
	);
	mismatch(
		errors,
		!clean(job.leaseOwner) && !clean(job.leaseToken),
		"job.lease"
	);

	mismatch(errors, Number(audit.__v || 0) === 0, "audit.__v");
	mismatch(
		errors,
		lower(audit.processingStatus) === "needs_review",
		"audit.processingStatus"
	);
	mismatch(
		errors,
		lower(audit.automationAction) === "skipped",
		"audit.automationAction"
	);
	mismatch(
		errors,
		lower(audit.skipReason) ===
			STALE_MAPPING_CODE.replace("room_mapping_stale", "local_record_blocked"),
		"audit.skipReason"
	);
	mismatch(
		errors,
		clean(audit.automationComment) === TERMINAL_MESSAGE,
		"audit.automationComment"
	);
	mismatch(
		errors,
		audit.hasReservationConnection !== true,
		"audit.hasReservationConnection"
	);
	mismatch(
		errors,
		emptyReference(audit.reservationMongoId),
		"audit.reservationMongoId"
	);
	mismatch(
		errors,
		exactArray(audit.matchedReservationBy, []),
		"audit.matchedReservationBy"
	);
	mismatch(
		errors,
		exactArray(audit.reconcileWarnings, []),
		"audit.reconcileWarnings"
	);
	mismatch(
		errors,
		exactArray(audit.reconcileErrors, [TERMINAL_MESSAGE]),
		"audit.reconcileErrors"
	);
	mismatch(
		errors,
		sameDate(audit.updatedAt, target.auditUpdatedAt),
		"audit.updatedAt"
	);
	mismatch(
		errors,
		lower(audit.hotelRunnerFirstFallback?.status) === "needs_review",
		"audit.hotelRunnerFirstFallback.status"
	);
	mismatch(
		errors,
		clean(audit.hotelRunnerFirstFallback?.lastErrorCode) === TERMINAL_CODE,
		"audit.hotelRunnerFirstFallback.lastErrorCode"
	);
	mismatch(
		errors,
		sameDate(audit.hotelRunnerFirstFallback?.finalizedAt, target.terminalAt),
		"audit.hotelRunnerFirstFallback.finalizedAt"
	);
	mismatch(
		errors,
		lower(audit.reconciliation?.status) === "needs_review",
		"audit.reconciliation.status"
	);
	mismatch(
		errors,
		lower(audit.reconciliation?.hotelRunnerFirstFallback?.decision) ===
			TERMINAL_DECISION,
		"audit.reconciliation.hotelRunnerFirstFallback.decision"
	);
	mismatch(
		errors,
		id(audit.reconciliation?.hotelRunnerFirstFallback?.jobId) === target.jobId,
		"audit.reconciliation.hotelRunnerFirstFallback.jobId"
	);
	return errors;
}

function reopenedLifecycleMismatches(scope) {
	const { target, job, audit } = scope;
	const errors = [];
	mismatch(errors, Number(job.__v || 0) === 1, "job.__v");
	mismatch(errors, lower(job.status) === "awaiting_hotelrunner", "job.status");
	mismatch(errors, Number(job.attemptCount) === 0, "job.attemptCount");
	mismatch(
		errors,
		lower(job.lastDecision) === REOPEN_DECISION,
		"job.lastDecision"
	);
	mismatch(
		errors,
		!clean(job.lastErrorCode) && !clean(job.lastErrorMessage),
		"job.lastError"
	);
	mismatch(errors, !dateMs(job.completedAt), "job.completedAt");
	mismatch(
		errors,
		!clean(job.inboundAuditFinalizationStatus),
		"job.inboundAuditFinalizationStatus"
	);
	mismatch(
		errors,
		!dateMs(job.inboundAuditFinalizedAt),
		"job.inboundAuditFinalizedAt"
	);
	mismatch(
		errors,
		emptyReference(job.reservationMongoId),
		"job.reservationMongoId"
	);
	mismatch(
		errors,
		emptyReference(job.hotelRunnerEventId),
		"job.hotelRunnerEventId"
	);
	mismatch(
		errors,
		emptyReference(job.hotelRunnerMirrorId),
		"job.hotelRunnerMirrorId"
	);
	mismatch(
		errors,
		!clean(job.pendingTerminalStatus),
		"job.pendingTerminalStatus"
	);
	mismatch(
		errors,
		!clean(job.leaseOwner) && !clean(job.leaseToken),
		"job.lease"
	);
	mismatch(
		errors,
		Number.isFinite(dateMs(job.nextAttemptAt)),
		"job.nextAttemptAt"
	);

	mismatch(errors, Number(audit.__v || 0) === 1, "audit.__v");
	mismatch(
		errors,
		["awaiting_hotelrunner", "parsed_awaiting_hotelrunner"].includes(
			lower(audit.processingStatus)
		),
		"audit.processingStatus"
	);
	mismatch(
		errors,
		lower(audit.automationAction) === "queued",
		"audit.automationAction"
	);
	mismatch(errors, !clean(audit.skipReason), "audit.skipReason");
	mismatch(
		errors,
		clean(audit.automationComment) === AWAITING_MESSAGE,
		"audit.automationComment"
	);
	mismatch(
		errors,
		audit.hasReservationConnection !== true,
		"audit.hasReservationConnection"
	);
	mismatch(
		errors,
		emptyReference(audit.reservationMongoId),
		"audit.reservationMongoId"
	);
	mismatch(
		errors,
		exactArray(audit.matchedReservationBy, []),
		"audit.matchedReservationBy"
	);
	mismatch(
		errors,
		exactArray(audit.reconcileWarnings, []),
		"audit.reconcileWarnings"
	);
	mismatch(
		errors,
		exactArray(audit.reconcileErrors, []),
		"audit.reconcileErrors"
	);
	mismatch(
		errors,
		lower(audit.hotelRunnerFirstFallback?.status) === "enqueued",
		"audit.hotelRunnerFirstFallback.status"
	);
	mismatch(
		errors,
		lower(audit.hotelRunnerFirstFallback?.recoveryId) === RECOVERY_ID,
		"audit.hotelRunnerFirstFallback.recoveryId"
	);
	mismatch(
		errors,
		validSerialRunId(audit.hotelRunnerFirstFallback?.serialRunId),
		"audit.hotelRunnerFirstFallback.serialRunId"
	);
	mismatch(
		errors,
		!dateMs(audit.hotelRunnerFirstFallback?.finalizedAt),
		"audit.hotelRunnerFirstFallback.finalizedAt"
	);
	mismatch(
		errors,
		!clean(audit.hotelRunnerFirstFallback?.lastErrorCode) &&
			!clean(audit.hotelRunnerFirstFallback?.lastErrorMessage),
		"audit.hotelRunnerFirstFallback.lastError"
	);
	mismatch(
		errors,
		sameDate(
			job.nextAttemptAt,
			audit.hotelRunnerFirstFallback?.recoveryHoldUntil
		),
		"job/audit.recoveryHoldUntil"
	);
	mismatch(
		errors,
		lower(audit.reconciliation?.status) === "awaiting_hotelrunner",
		"audit.reconciliation.status"
	);
	mismatch(
		errors,
		audit.reconciliation?.hotelRunnerFirst === true,
		"audit.reconciliation.hotelRunnerFirst"
	);
	const recoveryHistory = Array.isArray(
		audit.hotelRunnerFirstFallback?.recoveryHistory
	)
		? audit.hotelRunnerFirstFallback.recoveryHistory
		: [];
	const recoveryEntry = [...recoveryHistory]
		.reverse()
		.find((entry) => lower(entry?.recoveryId) === RECOVERY_ID);
	const previousTerminal = recoveryEntry?.previousTerminal;
	mismatch(errors, Boolean(recoveryEntry), "audit.recoveryHistory");
	mismatch(
		errors,
		clean(recoveryEntry?.serialRunId) ===
			clean(audit.hotelRunnerFirstFallback?.serialRunId),
		"audit.recoveryHistory.serialRunId"
	);
	mismatch(
		errors,
		sameDate(
			recoveryEntry?.recoveryLeaseUntil,
			audit.hotelRunnerFirstFallback?.recoveryLeaseUntil
		),
		"audit.recoveryHistory.leaseUntil"
	);
	mismatch(
		errors,
		sameDate(
			recoveryEntry?.reopenedAt,
			audit.hotelRunnerFirstFallback?.reopenedAt
		) && sameDate(audit.updatedAt, audit.hotelRunnerFirstFallback?.reopenedAt),
		"audit.recoveryHistory.reopenedAt"
	);
	mismatch(
		errors,
		lower(job.hotelRunnerStaleMappingRecovery?.recoveryId) === RECOVERY_ID &&
			clean(job.hotelRunnerStaleMappingRecovery?.serialRunId) ===
				clean(audit.hotelRunnerFirstFallback?.serialRunId) &&
			sameDate(
				job.hotelRunnerStaleMappingRecovery?.leaseUntil,
				audit.hotelRunnerFirstFallback?.recoveryLeaseUntil
			),
		"job.recoveryMarker"
	);
	mismatch(
		errors,
		previousTerminal &&
			Object.prototype.hasOwnProperty.call(previousTerminal, "jobResult"),
		"audit.recoveryHistory.jobResult"
	);
	mismatch(
		errors,
		lower(previousTerminal?.hotelRunnerFirstFallback?.status) ===
			"needs_review" &&
			clean(previousTerminal?.hotelRunnerFirstFallback?.lastErrorCode) ===
				TERMINAL_CODE,
		"audit.recoveryHistory.hotelRunnerFirstFallback"
	);
	mismatch(
		errors,
		lower(
			previousTerminal?.reconciliationHotelRunnerFirstFallback?.decision
		) === TERMINAL_DECISION &&
			id(previousTerminal?.reconciliationHotelRunnerFirstFallback?.jobId) ===
				target.jobId,
		"audit.recoveryHistory.reconciliationHotelRunnerFirstFallback"
	);
	return errors;
}

function projectedEvidenceMismatches(scope) {
	const { event, mirror } = scope;
	const errors = [];
	const reservationId = id(event.reservationMongoId);
	mismatch(errors, validObjectId(reservationId), "event.reservationMongoId");
	mismatch(
		errors,
		id(mirror.reservationMongoId) === reservationId,
		"mirror.reservationMongoId"
	);
	mismatch(errors, lower(event.status) === "completed", "event.status");
	mismatch(
		errors,
		["created", "updated"].includes(lower(mirror.projectionStatus)),
		"mirror.projectionStatus"
	);
	return errors;
}

function convergedMismatches(scope) {
	const { target, event, mirror, job, audit } = scope;
	const errors = projectedEvidenceMismatches(scope);
	const reservationId = id(event.reservationMongoId);
	mismatch(errors, validObjectId(reservationId), "reservationMongoId");
	mismatch(
		errors,
		id(job.reservationMongoId) === reservationId,
		"job.reservationMongoId"
	);
	mismatch(
		errors,
		id(audit.reservationMongoId) === reservationId,
		"audit.reservationMongoId"
	);
	mismatch(errors, lower(job.status) === "completed_api", "job.status");
	mismatch(
		errors,
		id(job.hotelRunnerEventId) === target.eventId,
		"job.hotelRunnerEventId"
	);
	mismatch(
		errors,
		id(job.hotelRunnerMirrorId) === target.mirrorId,
		"job.hotelRunnerMirrorId"
	);
	mismatch(
		errors,
		audit.hasReservationConnection === true,
		"audit.hasReservationConnection"
	);
	mismatch(
		errors,
		lower(audit.hotelRunnerFirstFallback?.status) === "completed_api",
		"audit.hotelRunnerFirstFallback.status"
	);
	mismatch(
		errors,
		["created", "updated", "duplicate_reservation"].includes(
			lower(audit.processingStatus)
		),
		"audit.processingStatus"
	);
	return errors;
}

function recoveryHistoryEntry(audit) {
	const history = Array.isArray(
		audit?.hotelRunnerFirstFallback?.recoveryHistory
	)
		? audit.hotelRunnerFirstFallback.recoveryHistory
		: [];
	return [...history]
		.reverse()
		.find((entry) => lower(entry?.recoveryId) === RECOVERY_ID);
}

function exactRecoveryImage(scope) {
	const entry = recoveryHistoryEntry(scope.audit);
	if (!entry) return null;
	const serialRunId = clean(entry.serialRunId);
	const reopenedAt = new Date(entry.reopenedAt);
	const leaseUntil = new Date(entry.recoveryLeaseUntil);
	const errors = [];
	mismatch(errors, validSerialRunId(serialRunId), "recovery.serialRunId");
	mismatch(errors, Number.isFinite(dateMs(reopenedAt)), "recovery.reopenedAt");
	mismatch(errors, Number.isFinite(dateMs(leaseUntil)), "recovery.leaseUntil");
	mismatch(
		errors,
		dateMs(leaseUntil) === dateMs(reopenedAt) + SERIAL_LEASE_MS,
		"recovery.leaseDuration"
	);
	if (errors.length) return { state: "invalid", errors };
	const fakeReopenedJob = applyRecoveryUpdateToDocument(
		scope.job,
		buildJobReopenUpdate(reopenedAt, serialRunId, leaseUntil)
	);
	const terminalJobFilter = buildTerminalJobFilter(scope.target, scope.job);
	const terminalJob = Object.entries(terminalJobFilter).every(
		([key, expected]) =>
			canonicalEjsonSha256(getDocumentPath(scope.job, key)) ===
			canonicalEjsonSha256(expected)
	);
	const auditWithExpectedJobErrors = reopenedLifecycleMismatches({
		...scope,
		job: fakeReopenedJob,
	});
	if (terminalJob && !auditWithExpectedJobErrors.length) {
		return {
			state: "audit_reopened_job_terminal",
			errors: [],
			serialRunId,
			reopenedAt,
			leaseUntil,
		};
	}
	const reopenedErrors = reopenedLifecycleMismatches(scope);
	return {
		state: reopenedErrors.length ? "invalid" : "reopened",
		errors: reopenedErrors,
		serialRunId,
		reopenedAt,
		leaseUntil,
	};
}

function classifyScope(scope) {
	const identityErrors = identityMismatches(scope);
	if (identityErrors.length) return { state: "drift", errors: identityErrors };

	const convergedErrors = convergedMismatches(scope);
	if (!convergedErrors.length) return { state: "converged", errors: [] };

	const recoveryImage = exactRecoveryImage(scope);
	if (recoveryImage?.state === "audit_reopened_job_terminal") {
		return {
			state: "audit_reopened_job_terminal",
			errors: [],
			recoveryImage,
		};
	}
	if (recoveryImage?.state === "reopened") {
		if (!projectedEvidenceMismatches(scope).length) {
			return { state: "projected_waiting_fallback", errors: [], recoveryImage };
		}
		if (!requeuedProjectionMismatches(scope).length) {
			return {
				state: "requeued_waiting_projection",
				errors: [],
				recoveryImage,
			};
		}
		if (!staleEvidenceMismatches(scope).length) {
			return { state: "reopened_waiting_mapping", errors: [], recoveryImage };
		}
	}
	if (recoveryImage?.state === "invalid") {
		return { state: "drift", errors: recoveryImage.errors };
	}

	const reopenedErrors = reopenedLifecycleMismatches(scope);
	if (!reopenedErrors.length) {
		const projectedErrors = projectedEvidenceMismatches(scope);
		if (!projectedErrors.length) {
			return { state: "projected_waiting_fallback", errors: [] };
		}
		const staleErrors = staleEvidenceMismatches(scope);
		if (!staleErrors.length) {
			return { state: "reopened_waiting_mapping", errors: [] };
		}
		const requeuedErrors = requeuedProjectionMismatches(scope);
		if (!requeuedErrors.length) {
			return { state: "requeued_waiting_projection", errors: [] };
		}
	}

	const terminalErrors = [
		...staleEvidenceMismatches(scope),
		...terminalLifecycleMismatches(scope),
	];
	if (!terminalErrors.length)
		return { state: "terminal_stale_mapping", errors: [] };

	return {
		state: "drift",
		errors: Array.from(new Set([...terminalErrors, ...reopenedErrors])).slice(
			0,
			20
		),
	};
}

function buildPlan(scopes, plannedAt = new Date()) {
	const targets = scopes.map((scope) => ({
		target: scope.target,
		scope,
		...classifyScope(scope),
	}));
	const drifted = targets.filter((entry) => entry.state === "drift");
	if (drifted.length) {
		fail(
			`Exact recovery scope drifted: ${drifted
				.map((entry) => `${entry.target.key}(${entry.errors.join(",")})`)
				.join("; ")}`,
			"HOTELRUNNER_STALE_MAPPING_RECOVERY_SCOPE_DRIFT"
		);
	}
	return {
		recoveryId: RECOVERY_ID,
		plannedAt: new Date(plannedAt),
		targets,
		actions: targets.filter(
			(entry) =>
				entry.state === "terminal_stale_mapping" ||
				entry.state === "audit_reopened_job_terminal"
		),
	};
}

function buildTerminalJobFilter(target, job) {
	return {
		_id: oid(target.jobId),
		__v: 0,
		hotelId: oid(target.hotelId),
		provider: target.provider,
		confirmationNumber: target.confirmationNumber,
		identityKey: target.identityKey,
		inboundEmailId: oid(target.auditId),
		inboundEmailHash: job.inboundEmailHash,
		archiveFingerprint: job.archiveFingerprint,
		normalizedReservationHash: job.normalizedReservationHash,
		resolvedHotelProofHash: job.resolvedHotelProofHash,
		status: "needs_review",
		attemptCount: 1,
		lastDecision: TERMINAL_DECISION,
		lastErrorCode: TERMINAL_CODE,
		lastErrorMessage: TERMINAL_MESSAGE,
		completedAt: new Date(target.terminalAt),
		updatedAt: new Date(target.jobUpdatedAt),
		inboundAuditFinalizationStatus: "completed",
		inboundAuditFinalizedAt: new Date(target.terminalAt),
		"ingressDecision.status": "api_observed",
		"ingressDecision.apiObservationCount": 1,
		"ingressDecision.apiObservedAt": new Date(target.eventReceivedAt),
		reservationMongoId: null,
		hotelRunnerEventId: null,
		hotelRunnerMirrorId: null,
		identityConflict: false,
		result: cloneBson(job.result || {}),
	};
}

function buildTerminalAuditFilter(target, audit) {
	return {
		_id: oid(target.auditId),
		__v: 0,
		hotelId: oid(target.hotelId),
		provider: target.provider,
		confirmationNumber: target.confirmationNumber,
		intent: "new_reservation",
		eventType: "new",
		emailHash: audit.emailHash,
		processingStatus: "needs_review",
		automationAction: "skipped",
		skipReason: "hotelrunner_local_record_blocked",
		automationComment: TERMINAL_MESSAGE,
		hasReservationConnection: false,
		reservationMongoId: null,
		matchedReservationBy: [],
		reconcileWarnings: [],
		reconcileErrors: [TERMINAL_MESSAGE],
		updatedAt: new Date(target.auditUpdatedAt),
		"senderAuthentication.authenticatedAligned": true,
		"senderAuthentication.trustedProvider": target.provider,
		"normalizedReservation.provider": target.provider,
		"normalizedReservation.confirmationNumber": target.confirmationNumber,
		"normalizedReservation.inboundEmailId": target.auditId,
		"normalizedReservation.sourceSenderAuthenticated": true,
		"normalizedReservation.sourceSenderTrusted": true,
		"reconciliation.status": "needs_review",
		hotelRunnerFirstFallback: cloneBson(audit.hotelRunnerFirstFallback),
		"reconciliation.hotelRunnerFirstFallback": cloneBson(
			audit.reconciliation.hotelRunnerFirstFallback
		),
	};
}

function buildAwaitingReconciliation(target) {
	return {
		status: "awaiting_hotelrunner",
		actionTaken: "queued",
		skipReason: "",
		automationComment: AWAITING_MESSAGE,
		reservationId: null,
		hotelId: oid(target.hotelId),
		pmsConfirmationNumber: "",
		provider: target.provider,
		confirmationNumber: target.confirmationNumber,
		warnings: [],
		errors: [],
		hotelRunnerFirst: true,
	};
}

function assertSerialRun(serialRunId, leaseUntil) {
	if (!validSerialRunId(serialRunId)) {
		fail(
			"Standalone recovery requires a cryptographic serial run ID.",
			"HOTELRUNNER_STALE_MAPPING_RECOVERY_RUN_ID_INVALID"
		);
	}
	if (!Number.isFinite(dateMs(leaseUntil))) {
		fail(
			"Standalone recovery requires a bounded lease.",
			"HOTELRUNNER_STALE_MAPPING_RECOVERY_LEASE_INVALID"
		);
	}
}

function buildJobReopenUpdate(appliedAt, serialRunId, leaseUntil) {
	assertSerialRun(serialRunId, leaseUntil);
	const reopenedAt = new Date(appliedAt);
	const holdUntil = new Date(reopenedAt.getTime() + RECOVERY_HOLD_MS);
	return {
		$set: {
			status: "awaiting_hotelrunner",
			nextAttemptAt: holdUntil,
			attemptCount: 0,
			lookupAttemptCount: 0,
			lastDecision: REOPEN_DECISION,
			lastErrorCode: "",
			lastErrorMessage: "",
			inboundAuditFinalizationStatus: "",
			hotelRunnerStaleMappingRecovery: {
				recoveryId: RECOVERY_ID,
				serialRunId,
				leaseUntil: new Date(leaseUntil),
				reopenedAt,
			},
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

function buildAuditReopenUpdate(
	target,
	appliedAt,
	{ job, audit } = {},
	serialRunId,
	leaseUntil,
	ownerToken = serialRunId,
	ownerLeaseUntil = leaseUntil
) {
	if (!job || !audit) {
		fail(
			"The exact terminal job and audit are required to preserve recovery history.",
			"HOTELRUNNER_STALE_MAPPING_RECOVERY_HISTORY_REQUIRED"
		);
	}
	assertSerialRun(serialRunId, leaseUntil);
	const reopenedAt = new Date(appliedAt);
	const holdUntil = new Date(reopenedAt.getTime() + RECOVERY_HOLD_MS);
	const isLockAudit = target.auditId === TARGETS[0].auditId;
	return {
		$set: {
			processingStatus: "awaiting_hotelrunner",
			automationAction: "queued",
			skipReason: "",
			automationComment: AWAITING_MESSAGE,
			hasReservationConnection: false,
			matchedReservationBy: [],
			reservationMongoId: null,
			pmsConfirmationNumber: "",
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
			"hotelRunnerFirstFallback.recoveryId": RECOVERY_ID,
			"hotelRunnerFirstFallback.serialRunId": serialRunId,
			"hotelRunnerFirstFallback.recoveryLeaseUntil": new Date(leaseUntil),
			...(isLockAudit
				? {
						"hotelRunnerFirstFallback.recoveryOwnerToken": ownerToken,
						"hotelRunnerFirstFallback.recoveryOwnerLeaseUntil": new Date(
							ownerLeaseUntil
						),
				  }
				: {}),
			"hotelRunnerFirstFallback.reopenedAt": reopenedAt,
			"hotelRunnerFirstFallback.recoveryHoldUntil": holdUntil,
			updatedAt: reopenedAt,
		},
		$unset: {
			"hotelRunnerFirstFallback.finalizedAt": "",
			"reconciliation.hotelRunnerFirstFallback": "",
		},
		$push: {
			"hotelRunnerFirstFallback.recoveryHistory": {
				$each: [
					{
						recoveryId: RECOVERY_ID,
						serialRunId,
						recoveryLeaseUntil: new Date(leaseUntil),
						reopenedAt,
						previousTerminal: {
							status: "needs_review",
							code: TERMINAL_CODE,
							decision: TERMINAL_DECISION,
							finalizedAt: new Date(target.terminalAt),
							jobResult: cloneBson(job.result || {}),
							hotelRunnerFirstFallback: cloneBson(
								audit.hotelRunnerFirstFallback
							),
							reconciliationHotelRunnerFirstFallback: cloneBson(
								audit.reconciliation?.hotelRunnerFirstFallback || {}
							),
						},
					},
				],
				$slice: -5,
			},
		},
		$inc: { __v: 1 },
	};
}

const matchedOne = (result) =>
	Number(result?.matchedCount ?? result?.n ?? 0) === 1 &&
	Number(result?.modifiedCount ?? result?.nModified ?? 0) === 1;

async function applyPlanInTransaction({
	collections,
	appliedAt = new Date(),
	runTransaction = async (work) => work(null),
	serialRunId = newSerialRunId(),
}) {
	const leaseUntil = new Date(appliedAt.getTime() + SERIAL_LEASE_MS);
	const changed = await runTransaction(async (session) => {
		let attemptChanged = 0;
		const liveScopes = await loadScopes(collections, session);
		const livePlan = buildPlan(liveScopes, appliedAt);
		for (const entry of livePlan.actions) {
			const { target, scope } = entry;
			const recovery = entry.recoveryImage || {
				serialRunId,
				reopenedAt: appliedAt,
				leaseUntil,
			};
			if (entry.state === "terminal_stale_mapping") {
				const auditResult = await collections.audits.updateOne(
					buildTerminalAuditFilter(target, scope.audit),
					buildAuditReopenUpdate(
						target,
						recovery.reopenedAt,
						scope,
						recovery.serialRunId,
						recovery.leaseUntil
					),
					session ? { session } : undefined
				);
				if (!matchedOne(auditResult)) {
					fail(
						`${target.key}: exact inbound audit compare-and-set failed.`,
						"HOTELRUNNER_STALE_MAPPING_RECOVERY_AUDIT_CAS_LOST"
					);
				}
			}
			const jobResult = await collections.jobs.updateOne(
				buildTerminalJobFilter(target, scope.job),
				buildJobReopenUpdate(
					recovery.reopenedAt,
					recovery.serialRunId,
					recovery.leaseUntil
				),
				session ? { session } : undefined
			);
			if (!matchedOne(jobResult)) {
				fail(
					`${target.key}: exact fallback job compare-and-set failed.`,
					"HOTELRUNNER_STALE_MAPPING_RECOVERY_JOB_CAS_LOST"
				);
			}
			attemptChanged += 1;
		}
		return attemptChanged;
	});

	const afterScopes = await loadScopes(collections);
	const afterPlan = buildPlan(afterScopes, appliedAt);
	const invalid = afterPlan.targets.filter((entry) =>
		["terminal_stale_mapping", "drift"].includes(entry.state)
	);
	if (invalid.length) {
		fail(
			`Recovery postcondition failed for ${invalid
				.map((entry) => entry.target.key)
				.join(", ")}.`,
			"HOTELRUNNER_STALE_MAPPING_RECOVERY_POSTCONDITION_FAILED"
		);
	}
	return { changed, plan: afterPlan };
}

const standaloneReadOptions = Object.freeze({
	readPreference: "primary",
	readConcern: { level: "local" },
	promoteBuffers: false,
	promoteLongs: false,
	promoteValues: false,
});

function standaloneDocumentPlan(collectionName, target, role, before, update) {
	const originalDocument = cloneFullBson(before);
	const expectedDocument = applyRecoveryUpdateToDocument(
		originalDocument,
		update
	);
	return {
		collectionName,
		target,
		role,
		originalDocument,
		expectedDocument,
		originalHash: canonicalEjsonSha256(originalDocument),
		expectedHash: canonicalEjsonSha256(expectedDocument),
	};
}

async function readStandaloneDocument(collections, documentPlan) {
	return collections[documentPlan.collectionName].findOne(
		{ _id: cloneFullBson(documentPlan.originalDocument._id) },
		standaloneReadOptions
	);
}

async function replaceStandaloneWithReadback({
	collections,
	documentPlan,
	beforeDocument,
	afterDocument,
	beforeHash,
	afterHash,
}) {
	let acknowledgementError = null;
	try {
		const result = await collections[documentPlan.collectionName].replaceOne(
			buildFullDocumentCasFilter(beforeDocument),
			cloneFullBson(afterDocument),
			{ writeConcern: { w: "majority" } }
		);
		if (result?.acknowledged === false || !matchedOne(result)) {
			throw new Error(
				`${documentPlan.target.key}:${documentPlan.role} did not replace exactly one document.`
			);
		}
	} catch (error) {
		acknowledgementError = error;
	}
	const observed = await readStandaloneDocument(collections, documentPlan);
	const observedHash = observed ? canonicalEjsonSha256(observed) : "";
	if (observedHash === afterHash) {
		return {
			acknowledgementLost: Boolean(acknowledgementError),
			document: observed,
		};
	}
	if (observedHash === beforeHash) {
		const error = new RecoveryError(
			`${documentPlan.target.key}:${
				documentPlan.role
			} standalone CAS did not commit${
				acknowledgementError ? `: ${acknowledgementError.message}` : "."
			}`,
			"HOTELRUNNER_STALE_MAPPING_RECOVERY_STANDALONE_CAS_LOST"
		);
		error.writeResolution = "before";
		throw error;
	}
	const error = new RecoveryError(
		`${documentPlan.target.key}:${documentPlan.role} is neither the exact before nor after image.`,
		"HOTELRUNNER_STALE_MAPPING_RECOVERY_THIRD_STATE"
	);
	error.writeResolution = "changed_or_missing";
	throw error;
}

async function classifyStandaloneDocuments(collections, documentPlans) {
	const classifications = [];
	for (const documentPlan of documentPlans) {
		const observed = await readStandaloneDocument(collections, documentPlan);
		const hash = observed ? canonicalEjsonSha256(observed) : "";
		classifications.push({
			documentPlan,
			state:
				hash === documentPlan.originalHash
					? "original"
					: hash === documentPlan.expectedHash
					? "reopened"
					: "changed_or_missing",
		});
	}
	return classifications;
}

async function compensateStandaloneApply({
	collections,
	documentPlans,
	cause,
}) {
	const errors = [];
	let classifications = await classifyStandaloneDocuments(
		collections,
		documentPlans
	);
	const jobs = classifications
		.filter((entry) => entry.documentPlan.role === "job")
		.reverse();
	for (const entry of jobs) {
		if (entry.state !== "reopened") continue;
		try {
			await replaceStandaloneWithReadback({
				collections,
				documentPlan: entry.documentPlan,
				beforeDocument: entry.documentPlan.expectedDocument,
				afterDocument: entry.documentPlan.originalDocument,
				beforeHash: entry.documentPlan.expectedHash,
				afterHash: entry.documentPlan.originalHash,
			});
		} catch (error) {
			errors.push(error);
		}
	}
	classifications = await classifyStandaloneDocuments(
		collections,
		documentPlans
	);
	const audits = classifications
		.filter((entry) => ["audit", "lock"].includes(entry.documentPlan.role))
		.reverse();
	for (const entry of audits) {
		if (entry.state !== "reopened") continue;
		const pairedJob = classifications.find(
			(item) =>
				item.documentPlan.role === "job" &&
				item.documentPlan.target.key === entry.documentPlan.target.key
		);
		if (pairedJob && pairedJob.state !== "original") continue;
		try {
			await replaceStandaloneWithReadback({
				collections,
				documentPlan: entry.documentPlan,
				beforeDocument: entry.documentPlan.expectedDocument,
				afterDocument: entry.documentPlan.originalDocument,
				beforeHash: entry.documentPlan.expectedHash,
				afterHash: entry.documentPlan.originalHash,
			});
		} catch (error) {
			errors.push(error);
		}
	}
	const final = await classifyStandaloneDocuments(collections, documentPlans);
	if (final.some((entry) => entry.state === "changed_or_missing")) {
		fail(
			`Standalone recovery stopped on a concurrent third state: ${cause.message}`,
			"HOTELRUNNER_STALE_MAPPING_RECOVERY_MANUAL_INTERVENTION_REQUIRED"
		);
	}
	if (errors.length || !final.every((entry) => entry.state === "original")) {
		fail(
			`Standalone compensation could not restore every safe original: ${cause.message}`,
			"HOTELRUNNER_STALE_MAPPING_RECOVERY_COMPENSATION_FAILED"
		);
	}
	fail(
		`Standalone apply failed and every write was restored exactly: ${cause.message}`,
		"HOTELRUNNER_STALE_MAPPING_RECOVERY_COMPENSATED"
	);
}

async function assertStandaloneOwner(
	collections,
	ownerToken,
	now = new Date()
) {
	const lockAudit = await collections.audits.findOne(
		{ _id: oid(TARGETS[0].auditId) },
		standaloneReadOptions
	);
	if (
		clean(lockAudit?.hotelRunnerFirstFallback?.recoveryOwnerToken) !==
			ownerToken ||
		dateMs(lockAudit?.hotelRunnerFirstFallback?.recoveryOwnerLeaseUntil) <=
			now.getTime()
	) {
		fail(
			"The standalone recovery ownership lease is not held by this invocation.",
			"HOTELRUNNER_STALE_MAPPING_RECOVERY_LOCK_LOST"
		);
	}
}

async function applyPlanStandalone({
	collections,
	appliedAt = new Date(),
	serialRunId = newSerialRunId(),
	clock = () => new Date(),
}) {
	const liveScopes = await loadScopes(collections, null, standaloneReadOptions);
	const livePlan = buildPlan(liveScopes, appliedAt);
	if (!livePlan.actions.length) {
		return { changed: 0, acknowledgementsRecovered: 0, plan: livePlan };
	}
	const ownerLeaseUntil = new Date(appliedAt.getTime() + SERIAL_LEASE_MS);
	const recoveryImages = livePlan.targets
		.map((entry) => entry.recoveryImage)
		.filter(Boolean);
	const recoveryImageKeys = new Set(
		recoveryImages.map((image) =>
			[
				clean(image.serialRunId),
				dateMs(image.reopenedAt),
				dateMs(image.leaseUntil),
			].join(":")
		)
	);
	if (recoveryImageKeys.size > 1) {
		fail(
			"Existing standalone targets carry mixed recovery images.",
			"HOTELRUNNER_STALE_MAPPING_RECOVERY_MIXED_IMAGES"
		);
	}
	const existingRecovery = recoveryImages[0] || null;
	if (
		existingRecovery &&
		dateMs(
			liveScopes[0]?.audit?.hotelRunnerFirstFallback?.recoveryOwnerLeaseUntil
		) > appliedAt.getTime()
	) {
		fail(
			"A standalone recovery invocation still owns the bounded lease.",
			"HOTELRUNNER_STALE_MAPPING_RECOVERY_LOCK_HELD"
		);
	}
	const imageRecovery = existingRecovery || {
		serialRunId,
		reopenedAt: appliedAt,
		leaseUntil: ownerLeaseUntil,
	};
	const lockPlans = [];
	const auditPlans = [];
	const jobPlans = [];
	if (existingRecovery) {
		const currentLockAudit = liveScopes[0].audit;
		const adoptedLockAudit = cloneFullBson(currentLockAudit);
		setDocumentPath(
			adoptedLockAudit,
			"hotelRunnerFirstFallback.recoveryOwnerToken",
			serialRunId
		);
		setDocumentPath(
			adoptedLockAudit,
			"hotelRunnerFirstFallback.recoveryOwnerLeaseUntil",
			ownerLeaseUntil
		);
		lockPlans.push({
			collectionName: "audits",
			target: TARGETS[0],
			role: "lock",
			originalDocument: cloneFullBson(currentLockAudit),
			expectedDocument: adoptedLockAudit,
			originalHash: canonicalEjsonSha256(currentLockAudit),
			expectedHash: canonicalEjsonSha256(adoptedLockAudit),
		});
	}
	for (const entry of livePlan.actions) {
		const recovery = entry.recoveryImage || imageRecovery;
		if (entry.state === "terminal_stale_mapping") {
			auditPlans.push(
				standaloneDocumentPlan(
					"audits",
					entry.target,
					"audit",
					entry.scope.audit,
					buildAuditReopenUpdate(
						entry.target,
						recovery.reopenedAt,
						entry.scope,
						recovery.serialRunId,
						recovery.leaseUntil,
						serialRunId,
						ownerLeaseUntil
					)
				)
			);
		}
		jobPlans.push(
			standaloneDocumentPlan(
				"jobs",
				entry.target,
				"job",
				entry.scope.job,
				buildJobReopenUpdate(
					recovery.reopenedAt,
					recovery.serialRunId,
					recovery.leaseUntil
				)
			)
		);
	}
	const documentPlans = [...lockPlans, ...auditPlans, ...jobPlans];
	let acknowledgementsRecovered = 0;
	try {
		for (let index = 0; index < documentPlans.length; index += 1) {
			if (index > 0)
				await assertStandaloneOwner(collections, serialRunId, clock());
			const resolution = await replaceStandaloneWithReadback({
				collections,
				documentPlan: documentPlans[index],
				beforeDocument: documentPlans[index].originalDocument,
				afterDocument: documentPlans[index].expectedDocument,
				beforeHash: documentPlans[index].originalHash,
				afterHash: documentPlans[index].expectedHash,
			});
			if (resolution.acknowledgementLost) acknowledgementsRecovered += 1;
		}
	} catch (error) {
		const observedLock = await collections.audits.findOne(
			{ _id: oid(TARGETS[0].auditId) },
			standaloneReadOptions
		);
		if (
			clean(observedLock?.hotelRunnerFirstFallback?.recoveryOwnerToken) &&
			clean(observedLock.hotelRunnerFirstFallback.recoveryOwnerToken) !==
				serialRunId &&
			dateMs(observedLock.hotelRunnerFirstFallback.recoveryOwnerLeaseUntil) >
				clock().getTime()
		) {
			fail(
				"Another standalone recovery invocation owns the bounded lease.",
				"HOTELRUNNER_STALE_MAPPING_RECOVERY_LOCK_HELD"
			);
		}
		return compensateStandaloneApply({
			collections,
			documentPlans,
			cause: error,
		});
	}
	const final = await classifyStandaloneDocuments(collections, documentPlans);
	if (!final.every((entry) => entry.state === "reopened")) {
		return compensateStandaloneApply({
			collections,
			documentPlans,
			cause: new Error("Standalone post-write verification was not all-new."),
		});
	}
	let afterPlan;
	try {
		afterPlan = buildPlan(
			await loadScopes(collections, null, standaloneReadOptions),
			appliedAt
		);
	} catch (error) {
		return compensateStandaloneApply({
			collections,
			documentPlans,
			cause: error,
		});
	}
	return {
		changed: livePlan.actions.length,
		acknowledgementsRecovered,
		plan: afterPlan,
	};
}

async function applyPlan(options) {
	return options.applyStrategy === STANDALONE_APPLY_STRATEGY
		? applyPlanStandalone(options)
		: applyPlanInTransaction(options);
}

function assertPostconditions(plan) {
	const incomplete = plan.targets.filter((entry) =>
		["terminal_stale_mapping", "drift"].includes(entry.state)
	);
	if (incomplete.length) {
		fail(
			`Recovery postconditions are not satisfied: ${incomplete
				.map((entry) => `${entry.target.key}:${entry.state}`)
				.join(", ")}.`,
			"HOTELRUNNER_STALE_MAPPING_RECOVERY_POSTCONDITION_FAILED"
		);
	}
	return true;
}

function sanitizedOutput(plan, mode, changed = 0, details = {}) {
	const counts = {};
	for (const entry of plan.targets) {
		counts[entry.state] = Number(counts[entry.state] || 0) + 1;
	}
	return {
		mode,
		recoveryId: RECOVERY_ID,
		targetCount: TARGETS.length,
		changedJobAuditPairs: changed,
		applyStrategy: details.applyStrategy,
		acknowledgementsRecovered:
			details.acknowledgementsRecovered == null
				? undefined
				: Number(details.acknowledgementsRecovered),
		counts,
		targets: plan.targets.map((entry) => ({
			key: entry.target.key,
			provider: entry.target.provider,
			confirmationNumber: entry.target.confirmationNumber,
			hotelRunnerReservationId: entry.target.hotelRunnerReservationId,
			eventId: entry.target.eventId,
			mirrorId: entry.target.mirrorId,
			jobId: entry.target.jobId,
			auditId: entry.target.auditId,
			state: entry.state,
		})),
		mutates: [COLLECTION_NAMES.jobs, COLLECTION_NAMES.audits],
		mutatesHotelRunnerEvents: false,
		mutatesHotelRunnerMirrors: false,
		mutatesPmsReservations: false,
		requeuesEvents: false,
		recoveryHoldMinutes: RECOVERY_HOLD_MS / 60_000,
		nextStep:
			"Publish a successful HotelRunner room-list generation; its built-in generation requeue owns stale-event revival.",
	};
}

async function connectDatabase(database) {
	await mongoose.connect(database, {
		autoIndex: false,
		autoCreate: false,
		readPreference: "primary",
	});
}

async function resolveApplyStrategy(admin = mongoose.connection.db?.admin()) {
	if (!admin || typeof admin.command !== "function") {
		fail(
			"MongoDB topology could not be positively inspected before apply.",
			"HOTELRUNNER_STALE_MAPPING_RECOVERY_TOPOLOGY_UNKNOWN"
		);
	}
	let hello;
	try {
		hello = await admin.command({ hello: 1 });
	} catch (error) {
		if (
			Number(error?.code) !== 59 &&
			lower(error?.codeName) !== "commandnotfound"
		) {
			throw error;
		}
		hello = await admin.command({ isMaster: 1 });
	}
	if (Number(hello?.ok) !== 1) {
		fail(
			"MongoDB topology inspection did not return ok:1.",
			"HOTELRUNNER_STALE_MAPPING_RECOVERY_TOPOLOGY_UNKNOWN"
		);
	}
	if (hello?.isWritablePrimary !== true && hello?.ismaster !== true) {
		fail(
			"The recovery must connect directly to a writable primary or mongos.",
			"HOTELRUNNER_STALE_MAPPING_RECOVERY_PRIMARY_REQUIRED"
		);
	}
	if (hello?.msg && hello.msg !== "isdbgrid") {
		fail(
			"MongoDB returned an unrecognized writable topology.",
			"HOTELRUNNER_STALE_MAPPING_RECOVERY_TOPOLOGY_UNKNOWN"
		);
	}
	if (hello?.setName || hello?.msg === "isdbgrid") {
		return TRANSACTION_APPLY_STRATEGY;
	}
	const nonStandaloneSignals = [
		hello?.hosts,
		hello?.passives,
		hello?.arbiters,
		hello?.primary,
		hello?.serviceId,
	].some((value) =>
		Array.isArray(value) ? value.length > 0 : value != null && value !== ""
	);
	if (
		nonStandaloneSignals ||
		hello?.secondary === true ||
		hello?.arbiterOnly === true ||
		hello?.hidden === true
	) {
		fail(
			"MongoDB did not positively identify a standalone writable primary.",
			"HOTELRUNNER_STALE_MAPPING_RECOVERY_TOPOLOGY_UNKNOWN"
		);
	}
	return STANDALONE_APPLY_STRATEGY;
}

async function main(
	argv = process.argv.slice(2),
	{
		clock = () => new Date(),
		connect = connectDatabase,
		disconnect = async () => mongoose.disconnect(),
		db: injectedDb = null,
		collections: injectedCollections = null,
		runTransaction: injectedTransaction = null,
		resolveDatabaseApplyStrategy = resolveApplyStrategy,
		skipConnect = false,
	} = {}
) {
	const options = parseArguments(argv);
	if (options.help) {
		return {
			usage: [
				"node scripts/recoverHotelRunnerStaleMappingEvents20260810.js",
				`node scripts/recoverHotelRunnerStaleMappingEvents20260810.js --apply --repair-id=${RECOVERY_ID}`,
				"node scripts/recoverHotelRunnerStaleMappingEvents20260810.js --postconditions",
			],
		};
	}
	const database =
		process.env.DATABASE || process.env.MONGO_URI || process.env.MONGODB_URI;
	if (!skipConnect && !database) {
		fail(
			"Missing DATABASE/MONGO connection string.",
			"HOTELRUNNER_STALE_MAPPING_RECOVERY_DATABASE_REQUIRED"
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
		const before = buildPlan(await loadScopes(collections), now);

		if (options.postconditions) {
			assertPostconditions(before);
			return sanitizedOutput(before, "postconditions", 0);
		}
		if (!options.apply) return sanitizedOutput(before, "dry_run", 0);
		const applyStrategy = await resolveDatabaseApplyStrategy(db?.admin?.());

		const runTransaction =
			injectedTransaction ||
			(async (work) => {
				const session = await mongoose.startSession();
				try {
					let value;
					await session.withTransaction(
						async () => {
							value = await work(session);
						},
						{
							readConcern: { level: "snapshot" },
							writeConcern: { w: "majority" },
						}
					);
					return value;
				} finally {
					await session.endSession();
				}
			});
		const applied = await applyPlan({
			collections,
			appliedAt: now,
			runTransaction,
			applyStrategy,
		});
		return sanitizedOutput(applied.plan, "apply", applied.changed, {
			applyStrategy,
			acknowledgementsRecovered: applied.acknowledgementsRecovered,
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
							error?.code || "HOTELRUNNER_STALE_MAPPING_RECOVERY_UNEXPECTED",
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
	COLLECTION_NAMES,
	HOTEL_ID,
	RECOVERY_HOLD_MS,
	RECOVERY_ID,
	REOPEN_DECISION,
	SERIAL_LEASE_MS,
	STALE_MAPPING_CODE,
	STANDALONE_APPLY_STRATEGY,
	TARGETS,
	TERMINAL_CODE,
	TERMINAL_DECISION,
	TERMINAL_MESSAGE,
	TRANSACTION_APPLY_STRATEGY,
	RecoveryError,
	applyPlan,
	applyPlanInTransaction,
	applyPlanStandalone,
	applyRecoveryUpdateToDocument,
	assertPostconditions,
	buildAuditReopenUpdate,
	buildAwaitingReconciliation,
	buildJobReopenUpdate,
	buildFullDocumentCasFilter,
	buildPlan,
	buildTerminalAuditFilter,
	buildTerminalJobFilter,
	canonicalEjsonSha256,
	classifyScope,
	cloneFullBson,
	compensateStandaloneApply,
	collectionsFromDb,
	identityMismatches,
	loadScopes,
	main,
	parseArguments,
	replaceStandaloneWithReadback,
	resolveApplyStrategy,
	requeuedProjectionMismatches,
	reopenedLifecycleMismatches,
	sanitizedOutput,
	staleEvidenceMismatches,
	terminalLifecycleMismatches,
};
