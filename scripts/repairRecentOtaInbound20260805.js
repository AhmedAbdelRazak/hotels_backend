/**
 * Fixed-scope recovery runner for the OTA inbound records audited on
 * 2026-08-05.
 *
 * The command is deliberately one-target-at-a-time and dry-run by default.
 * It never reparses email, invokes AI, emits notifications, adjusts inventory,
 * or deletes source/backup documents. Apply and rollback use permanent,
 * hash-verified full-document backups plus exact BSON-aware CAS filters.
 *
 * Dry run:
 *   node scripts/repairRecentOtaInbound20260805.js --target <target-key>
 *
 * Apply:
 *   node scripts/repairRecentOtaInbound20260805.js --target <target-key> \
 *     --apply --repair-id <globally-unique-change-id>
 *
 * Rollback dry run / apply:
 *   node scripts/repairRecentOtaInbound20260805.js --target <target-key> \
 *     --rollback --repair-id <original-change-id>
 *   node scripts/repairRecentOtaInbound20260805.js --target <target-key> \
 *     --rollback --apply --repair-id <original-change-id>
 */

"use strict";

require("dotenv").config();

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const mongoose = require("mongoose");

mongoose.set("strictQuery", true);
mongoose.set("autoCreate", false);

const {
	MANIFEST_COLLECTION,
	OPERATION,
	TARGET_KEYS,
	applyPlanToScope,
	buildBackupCollectionName,
	buildBackupRecords,
	buildExactCasFilter,
	buildRecoveryPlan,
	canonicalEjsonSha256,
	canonicalEqual,
	classifyPlanScope,
	cloneBson,
	getTarget,
	id,
	targetAuditScope,
	validateTargetScope,
	verifyAppliedTarget,
	verifyBackupRecords,
	verifyRecoveryPlan,
} = require("../services/recentOtaInboundRecovery20260805");

const PRIMARY_MAJORITY_READ = Object.freeze({
	readPreference: "primary",
	readConcern: Object.freeze({ level: "majority" }),
});
const MAJORITY_WRITE = Object.freeze({
	writeConcern: Object.freeze({ w: "majority" }),
});
const RESERVATION_COLLECTION = "reservations";
const INBOUND_COLLECTION = "inboundemails";
const HOTEL_COLLECTION = "hoteldetails";
const MANIFEST_SCHEMA_VERSION = 1;

const usage = () => [
	"Usage:",
	"  node scripts/repairRecentOtaInbound20260805.js --target <target-key> [--repair-id <id>]",
	"  node scripts/repairRecentOtaInbound20260805.js --target <target-key> --apply --repair-id <unique-id>",
	"  node scripts/repairRecentOtaInbound20260805.js --target <target-key> --rollback --repair-id <id>",
	"  node scripts/repairRecentOtaInbound20260805.js --target <target-key> --rollback --apply --repair-id <id>",
	"",
	"Dry-run is the default. Exactly one explicit target is required.",
	"Apply requires a globally unique repair ID; IDs are never reusable.",
	"No AI, reparsing, notification, inventory, room invention, retry loop, or deletion occurs.",
	"",
	"Targets:",
	...TARGET_KEYS.map((key) => `  ${key}`),
].join("\n");

const parseArguments = (argv = []) => {
	const args = {
		apply: false,
		help: false,
		repairId: "",
		rollback: false,
		targetKey: "",
	};
	const seen = new Set();
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (token === "--apply" || token === "--rollback" || token === "--help" || token === "-h") {
			const key = token === "-h" ? "--help" : token;
			assert.equal(seen.has(key), false, `${key} may be supplied only once.`);
			seen.add(key);
			if (key === "--apply") args.apply = true;
			if (key === "--rollback") args.rollback = true;
			if (key === "--help") args.help = true;
			continue;
		}
		if (token === "--target" || token === "--repair-id") {
			assert.equal(seen.has(token), false, `${token} may be supplied only once.`);
			seen.add(token);
			const value = argv[index + 1];
			assert.ok(value && !String(value).startsWith("--"), `${token} requires a value.`);
			if (token === "--target") args.targetKey = String(value);
			else args.repairId = String(value);
			index += 1;
			continue;
		}
		throw new Error(`Unknown argument: ${token}`);
	}
	if (args.help) return args;
	assert.ok(args.targetKey, "Exactly one explicit --target is required.");
	getTarget(args.targetKey);
	if (args.repairId) buildBackupCollectionName(args.repairId);
	if (args.apply) assert.ok(args.repairId, "--apply requires a globally unique --repair-id.");
	if (args.rollback) assert.ok(args.repairId, "--rollback requires the original --repair-id.");
	return args;
};

const objectId = (value) => new mongoose.Types.ObjectId(String(value));
const readOptions = (extra = {}) => ({
	readPreference: PRIMARY_MAJORITY_READ.readPreference,
	readConcern: { ...PRIMARY_MAJORITY_READ.readConcern },
	...extra,
});
const writeOptions = (extra = {}) => ({
	writeConcern: { ...MAJORITY_WRITE.writeConcern },
	...extra,
});
const nowIso = () => new Date().toISOString();
const randomToken = () => crypto.randomBytes(24).toString("hex");

const buildAuditMatchQuery = (targetKey) => {
	const target = getTarget(targetKey);
	const scope = targetAuditScope(targetKey);
	const auditObjectIds = scope.auditIds.map(objectId);
	const auditIdAlternatives = [...auditObjectIds, ...scope.auditIds];
	const emailHashes = target.audits.map((audit) => audit.emailHash);
	const textHashes = target.audits.map((audit) => audit.textHash);
	const alternatives = [
		{ _id: { $in: auditObjectIds } },
		{ emailHash: { $in: emailHashes } },
		{ textHash: { $in: textHashes } },
		{ duplicateOf: { $in: auditIdAlternatives } },
	];
	if (target.mongoId) {
		const reservationIds = [objectId(target.mongoId), target.mongoId];
		alternatives.push(
			{ reservationMongoId: { $in: reservationIds } },
			{ "reconciliation.reservationId": { $in: reservationIds } },
			{ pmsConfirmationNumber: target.pmsConfirmation },
			{ "reconciliation.pmsConfirmationNumber": target.pmsConfirmation },
			{
				provider: { $in: scope.providers },
				confirmationNumber: target.otaConfirmation,
			},
			{
				"normalizedReservation.provider": { $in: scope.providers },
				"normalizedReservation.confirmationNumber": target.otaConfirmation,
			},
		);
	}
	return { $or: alternatives };
};

const assertExactAuditScope = (targetKey, audits) => {
	const expected = [...targetAuditScope(targetKey).auditIds].sort();
	const actual = audits.map((audit) => id(audit)).sort();
	assert.deepEqual(
		actual,
		expected,
		"A missing, duplicated, or unknown identity-linked inbound audit entered the target scope; aborting for a new audit.",
	);
	return true;
};

const collectionSet = (db) => ({
	audits: db.collection(INBOUND_COLLECTION),
	hotels: db.collection(HOTEL_COLLECTION),
	manifests: db.collection(MANIFEST_COLLECTION),
	reservations: db.collection(RESERVATION_COLLECTION),
});

const loadTargetScope = async ({ db, targetKey, validateOriginal = true }) => {
	const target = getTarget(targetKey);
	const collections = collectionSet(db);
	const reservation = target.mongoId
		? await collections.reservations.findOne({ _id: objectId(target.mongoId) }, readOptions())
		: null;
	const audits = await collections.audits
		.find(buildAuditMatchQuery(targetKey), readOptions())
		.sort({ receivedAt: 1, _id: 1 })
		.toArray();
	const hotel = target.kind === "hotel_assignment"
		? await collections.hotels.findOne({ _id: objectId(target.hotelId) }, readOptions())
		: null;
	assertExactAuditScope(targetKey, audits);
	if (validateOriginal) validateTargetScope({ targetKey, reservation, audits, hotel });
	return {
		audits,
		hotel,
		reservation,
		reservations: reservation ? [reservation] : [],
		target,
		targetKey,
	};
};

const buildPlanContext = ({ repairId, repairAt }) => {
	const fixedRepairId = String(repairId);
	return {
		backupCollection: buildBackupCollectionName(fixedRepairId),
		repairAt: new Date(repairAt),
		repairId: fixedRepairId,
	};
};

const planDescriptor = (plan) => ({
	context: {
		backupCollection: plan.context.backupCollection,
		repairAt: new Date(plan.context.repairAt).toISOString(),
		repairId: plan.context.repairId,
	},
	documents: plan.documentPlans.map((entry) => ({
		casFilterHash: entry.casFilterHash,
		collection: entry.collection,
		documentId: entry.documentId,
		expectedHash: entry.expectedHash,
		originalHash: entry.originalHash,
		role: entry.role,
		updateHash: canonicalEjsonSha256(entry.update),
	})),
	hotelEvidence: plan.hotelEvidence
		? { documentId: id(plan.hotelEvidence.document), hash: plan.hotelEvidence.hash }
		: null,
	immutableEvidence: plan.immutableEvidence.map((entry) => ({
		collection: entry.collection,
		documentId: entry.documentId,
		evidenceHash: entry.evidenceHash,
		originalHash: entry.originalHash,
		role: entry.role,
	})),
	operation: plan.operation,
	targetKey: plan.targetKey,
});

const planHash = (plan) => canonicalEjsonSha256(planDescriptor(plan));

const comparePlans = (left, right) => {
	verifyRecoveryPlan(left);
	verifyRecoveryPlan(right);
	assert.ok(canonicalEqual(planDescriptor(left), planDescriptor(right)), "Fresh target state no longer produces the backed-up exact recovery plan.");
	assert.equal(planHash(left), planHash(right), "Recovery plan hash changed.");
	return true;
};

const buildHotelBackupRecord = ({ plan, repairId, backupCollection, backupAt }) => {
	if (!plan.hotelEvidence) return null;
	const originalDocument = cloneBson(plan.hotelEvidence.document);
	const documentId = id(originalDocument);
	return {
		_id: `${repairId}:${HOTEL_COLLECTION}:${documentId}`,
		backupAt: new Date(backupAt),
		backupCollection,
		operation: OPERATION,
		originalDocument,
		originalHash: canonicalEjsonSha256(originalDocument),
		repairId,
		role: "hotel_evidence",
		sourceCollection: HOTEL_COLLECTION,
		sourceDocumentId: documentId,
		targetKey: plan.targetKey,
	};
};

const buildBackupRecordsForPlan = ({ plan, repairId, backupCollection, backupAt }) => {
	const records = buildBackupRecords({
		backupAt,
		backupCollection,
		plans: [plan],
		repairId,
	});
	const hotelRecord = buildHotelBackupRecord({ plan, repairId, backupCollection, backupAt });
	if (hotelRecord) records.push(hotelRecord);
	verifyBackupRecords({ records, repairId, backupCollection });
	return records;
};

const recordHashMap = (records) => Object.fromEntries(
	records
		.map((record) => [String(record._id), canonicalEjsonSha256(record)])
		.sort(([left], [right]) => left.localeCompare(right)),
);

const buildManifestDocument = ({ plan, records, applyToken, backupAt }) => {
	const createdAt = new Date(backupAt);
	return {
		_id: plan.context.repairId,
		applyToken,
		backupAt: createdAt,
		backupCollection: plan.context.backupCollection,
		backupRecordCount: records.length,
		backupRecordHashes: recordHashMap(records),
		createdAt,
		documentPlans: cloneBson(planDescriptor(plan).documents),
		history: [{ at: createdAt, state: "initializing" }],
		hotelEvidence: cloneBson(planDescriptor(plan).hotelEvidence),
		immutableEvidence: cloneBson(planDescriptor(plan).immutableEvidence),
		operation: OPERATION,
		planHash: planHash(plan),
		repairAt: new Date(plan.context.repairAt),
		repairId: plan.context.repairId,
		schemaVersion: MANIFEST_SCHEMA_VERSION,
		state: "initializing",
		targetKey: plan.targetKey,
		updatedAt: createdAt,
	};
};

const manifestIdentityMatches = (actual, expected) => Boolean(actual)
	&& actual._id === expected._id
	&& actual.operation === expected.operation
	&& actual.targetKey === expected.targetKey
	&& actual.applyToken === expected.applyToken
	&& actual.backupCollection === expected.backupCollection
	&& actual.planHash === expected.planHash
	&& actual.schemaVersion === expected.schemaVersion
	&& canonicalEqual(actual.backupRecordHashes, expected.backupRecordHashes);

const manifestImmutableFilter = (manifest = null) => {
	if (!manifest || typeof manifest !== "object") return {};
	const filter = {};
	for (const field of ["schemaVersion", "planHash", "backupCollection"]) {
		if (manifest[field] !== undefined) filter[field] = cloneBson(manifest[field]);
	}
	if (manifest.backupRecordHashes !== undefined) {
		filter.backupRecordHashes = cloneBson(manifest.backupRecordHashes);
	}
	return filter;
};

const assertManifestImmutableIdentity = (actual, expected = null) => {
	if (!expected || typeof expected !== "object") return true;
	for (const field of ["schemaVersion", "planHash", "backupCollection"]) {
		if (expected[field] === undefined) continue;
		assert.ok(
			canonicalEqual(actual?.[field], expected[field]),
			`Manifest immutable ${field} changed.`,
		);
	}
	if (expected.backupRecordHashes !== undefined) {
		assert.ok(
			canonicalEqual(actual?.backupRecordHashes, expected.backupRecordHashes),
			"Manifest immutable backupRecordHashes changed.",
		);
	}
	return true;
};

const readManifest = (manifestCollection, repairId) => manifestCollection.findOne(
	{ _id: repairId },
	readOptions(),
);

const claimNewRepair = async ({ manifestCollection, manifest }) => {
	let acknowledgementError = null;
	try {
		const result = await manifestCollection.insertOne(cloneBson(manifest), writeOptions());
		assert.equal(result.acknowledged, true, "Manifest insert was not acknowledged.");
		assert.equal(String(result.insertedId), manifest._id, "Manifest insertedId changed.");
	} catch (error) {
		acknowledgementError = error;
	}
	const readback = await readManifest(manifestCollection, manifest._id);
	if (manifestIdentityMatches(readback, manifest) && readback.state === "initializing") {
		return { acknowledgementLost: Boolean(acknowledgementError), manifest: readback };
	}
	if (readback) {
		throw new Error(`Repair ID ${manifest._id} already exists or is owned by another invocation; repair IDs are never reusable.`);
	}
	throw acknowledgementError || new Error("Manifest insert did not persist.");
};

const assertManifestFence = async ({
	manifestCollection,
	repairId,
	targetKey,
	applyToken,
	rollbackToken = "",
	manifestIdentity = null,
	states,
}) => {
	const manifest = await readManifest(manifestCollection, repairId);
	assert.ok(manifest, `Missing recovery manifest ${repairId}.`);
	assert.equal(manifest.operation, OPERATION, "Manifest operation changed.");
	assert.equal(manifest.targetKey, targetKey, "Manifest target changed.");
	assert.equal(manifest.applyToken, applyToken, "Manifest apply ownership token changed.");
	if (rollbackToken) assert.equal(manifest.rollbackToken, rollbackToken, "Manifest rollback ownership token changed.");
	assertManifestImmutableIdentity(manifest, manifestIdentity);
	assert.ok(states.includes(manifest.state), `Manifest state ${manifest.state} is not fenced for this write.`);
	return manifest;
};

const transitionManifest = async ({
	manifestCollection,
	repairId,
	targetKey,
	applyToken,
	rollbackToken = "",
	manifestIdentity = null,
	fromStates,
	toState,
	set = {},
	unset = {},
}) => {
	const at = new Date();
	const update = {
		$push: { history: { at, state: toState } },
		$set: { ...cloneBson(set), state: toState, updatedAt: at },
	};
	if (Object.keys(unset).length) update.$unset = { ...unset };
	const removesRollbackToken = rollbackToken
		&& Object.prototype.hasOwnProperty.call(unset, "rollbackToken");
	let acknowledgementError = null;
	let result = null;
	try {
		result = await manifestCollection.updateOne(
			{
				_id: repairId,
				applyToken,
				...(rollbackToken ? { rollbackToken } : {}),
				...manifestImmutableFilter(manifestIdentity),
				operation: OPERATION,
				state: { $in: fromStates },
				targetKey,
			},
			update,
			writeOptions(),
		);
		assert.equal(result.acknowledged, true, "Manifest transition was not acknowledged.");
	} catch (error) {
		acknowledgementError = error;
	}
	const readback = await readManifest(manifestCollection, repairId);
	if (
		readback
		&& readback.operation === OPERATION
		&& readback.targetKey === targetKey
		&& readback.applyToken === applyToken
		&& (
			!rollbackToken
			|| (removesRollbackToken
				? !Object.prototype.hasOwnProperty.call(readback, "rollbackToken")
				: readback.rollbackToken === rollbackToken)
		)
		&& readback.state === toState
	) {
		assertManifestImmutableIdentity(readback, manifestIdentity);
		return { acknowledgementLost: Boolean(acknowledgementError), manifest: readback };
	}
	if (!acknowledgementError && result?.matchedCount === 0) {
		throw new Error(`Manifest transition ${fromStates.join("|")} -> ${toState} lost its state fence.`);
	}
	throw acknowledgementError || new Error(`Manifest did not reach ${toState}.`);
};

const verifyBackupReadback = ({ plannedRecords, readback, repairId, backupCollection }) => {
	verifyBackupRecords({ records: readback, repairId, backupCollection });
	assert.equal(readback.length, plannedRecords.length, "Backup collection contains a missing or unexpected record.");
	assert.deepEqual(recordHashMap(readback), recordHashMap(plannedRecords), "Backup full-document hash readback failed.");
	const plannedById = new Map(plannedRecords.map((record) => [String(record._id), record]));
	for (const record of readback) {
		assert.ok(canonicalEqual(record, plannedById.get(String(record._id))), `Backup record ${record._id} changed during persistence.`);
	}
	return true;
};

const createAndVerifyBackup = async ({ db, records, context }) => {
	const existing = await db.listCollections({ name: context.backupCollection }, { nameOnly: true }).toArray();
	assert.equal(existing.length, 0, `Backup collection ${context.backupCollection} already exists; refusing reuse.`);
	let createError = null;
	try {
		await db.createCollection(context.backupCollection, writeOptions());
	} catch (error) {
		createError = error;
	}
	const existsAfterCreate = await db.listCollections({ name: context.backupCollection }, { nameOnly: true }).toArray();
	assert.equal(existsAfterCreate.length, 1, createError?.message || "Backup collection creation was not durable.");
	const backupCollection = db.collection(context.backupCollection);
	let insertError = null;
	try {
		const result = await backupCollection.insertMany(records.map(cloneBson), {
			...writeOptions(),
			ordered: true,
		});
		assert.equal(result.acknowledged, true, "Backup insert was not acknowledged.");
	} catch (error) {
		insertError = error;
	}
	const readback = await backupCollection.find({}, readOptions()).sort({ _id: 1 }).toArray();
	try {
		verifyBackupReadback({
			backupCollection: context.backupCollection,
			plannedRecords: records,
			readback,
			repairId: context.repairId,
		});
	} catch (verificationError) {
		if (insertError) verificationError.cause = insertError;
		throw verificationError;
	}
	return { acknowledgementLost: Boolean(createError || insertError), readback };
};

const collectionForDocumentPlan = (db, documentPlan) => {
	if (documentPlan.collection === RESERVATION_COLLECTION) return db.collection(RESERVATION_COLLECTION);
	if (documentPlan.collection === INBOUND_COLLECTION) return db.collection(INBOUND_COLLECTION);
	throw new Error(`Mutable collection ${documentPlan.collection} is outside the recovery allowlist.`);
};

const readDocumentPlan = ({ db, documentPlan }) => collectionForDocumentPlan(db, documentPlan).findOne(
	{ _id: objectId(documentPlan.documentId) },
	readOptions(),
);

const executeDocumentWriteWithHashReadback = async ({
	db,
	documentPlan,
	write,
	beforeHash,
	afterHash,
}) => {
	let acknowledgementError = null;
	try {
		const result = await write();
		assert.equal(result.acknowledged, true, `${documentPlan.role} write was not acknowledged.`);
		assert.equal(result.matchedCount, 1, `${documentPlan.role} exact CAS did not match.`);
	} catch (error) {
		acknowledgementError = error;
	}
	// Exactly one primary/majority read resolves a lost acknowledgement. There
	// is intentionally no retry or polling loop.
	const document = await readDocumentPlan({ db, documentPlan });
	const observedHash = document ? canonicalEjsonSha256(document) : "";
	if (observedHash === afterHash) {
		return {
			acknowledgementError: acknowledgementError?.message || "",
			acknowledgementLost: Boolean(acknowledgementError),
			document,
			observedHash,
			state: "after",
		};
	}
	if (observedHash === beforeHash) {
		const error = new Error(acknowledgementError
			? `${documentPlan.role} write did not commit: ${acknowledgementError.message}`
			: `${documentPlan.role} write acknowledgement did not produce the exact expected document.`);
		error.writeResolution = "before";
		error.observedHash = observedHash;
		throw error;
	}
	const error = new Error(`${documentPlan.role} write is ambiguous: live hash ${observedHash || "missing"} is neither exact before nor exact after.`);
	error.writeResolution = "changed_or_missing";
	error.observedHash = observedHash;
	error.acknowledgementError = acknowledgementError?.message || "";
	throw error;
};

const assertEvidenceUnchanged = ({ plan, scope }) => {
	const auditsById = new Map(scope.audits.map((audit) => [id(audit), audit]));
	for (const evidence of plan.immutableEvidence) {
		const actual = auditsById.get(evidence.documentId);
		assert.ok(actual, `Missing immutable audit evidence ${evidence.documentId}.`);
		assert.equal(canonicalEjsonSha256(actual), evidence.originalHash, `Immutable audit ${evidence.documentId} changed.`);
	}
	if (plan.hotelEvidence) {
		assert.ok(scope.hotel, "Hotel evidence disappeared.");
		assert.equal(canonicalEjsonSha256(scope.hotel), plan.hotelEvidence.hash, "Hotel evidence changed.");
	}
	return true;
};

const assertOriginalMutableDocuments = ({ plan, scope }) => {
	const classifications = classifyPlanScope({ plan, scope });
	assert.ok(classifications.every((entry) => entry.state === "original"), "Target documents are not all in the exact original state.");
	return classifications;
};

const assertExpectedMutableDocuments = ({ plan, scope }) => {
	verifyAppliedTarget({ plan, scope });
	assertEvidenceUnchanged({ plan, scope });
	return classifyPlanScope({ plan, scope });
};

const buildPlanForScope = ({ targetKey, scope, context }) => buildRecoveryPlan({
	audits: scope.audits,
	context,
	hotel: scope.hotel,
	reservation: scope.reservation,
	targetKey,
});

const recoveryReport = ({ args, plan, classifications, state, writesPerformed, extra = {} }) => ({
	applyRequested: args.apply,
	backupCollection: plan.context.backupCollection,
	documents: classifications.map((entry) => ({
		collection: entry.collection,
		documentId: entry.documentId,
		role: entry.role,
		state: entry.state,
	})),
	immutableEvidenceDocuments: plan.immutableEvidence.length,
	operation: OPERATION,
	planHash: planHash(plan),
	repairId: plan.context.repairId,
	rollbackRequested: args.rollback,
	state,
	targetKey: plan.targetKey,
	writesPerformed,
	...extra,
});

const markManualIntervention = async ({
	manifestCollection,
	manifest,
	manifestIdentity = manifest,
	reason,
	fromStates,
}) => {
	if (!manifest || manifest.state === "manual_intervention_required") return manifest;
	return (await transitionManifest({
		applyToken: manifest.applyToken,
		fromStates,
		manifestIdentity,
		manifestCollection,
		repairId: manifest.repairId,
		rollbackToken: manifest.rollbackToken || "",
		set: {
			manualIntervention: {
				at: new Date(),
				reason: String(reason || "Unknown recovery failure").slice(0, 2000),
			},
		},
		targetKey: manifest.targetKey,
		toState: "manual_intervention_required",
	})).manifest;
};

const compensateApply = async ({ db, plan, manifest, cause }) => {
	const manifestCollection = db.collection(MANIFEST_COLLECTION);
	let currentManifest = await assertManifestFence({
		applyToken: manifest.applyToken,
		manifestIdentity: manifest,
		manifestCollection,
		repairId: manifest.repairId,
		states: ["applying", "compensating"],
		targetKey: manifest.targetKey,
	});
	let scope;
	try {
		scope = await loadTargetScope({ db, targetKey: plan.targetKey, validateOriginal: false });
		assertEvidenceUnchanged({ plan, scope });
	} catch (error) {
		await markManualIntervention({
			fromStates: [currentManifest.state],
			manifest: currentManifest,
			manifestCollection,
			reason: `Compensation preflight failed: ${error.message}`,
		});
		throw error;
	}
	const initial = classifyPlanScope({ plan, scope });
	if (initial.some((entry) => entry.state === "changed_or_missing")) {
		await markManualIntervention({
			fromStates: [currentManifest.state],
			manifest: currentManifest,
			manifestCollection,
			reason: `Unknown live hash during apply compensation: ${cause.message}`,
		});
		throw new Error("Apply compensation stopped: at least one mutable document is neither the exact original nor exact repaired shape.");
	}
	if (initial.every((entry) => entry.state === "original")) {
		const state = currentManifest.state === "applying" ? "failed_no_change" : "compensated";
		await transitionManifest({
			applyToken: manifest.applyToken,
			fromStates: [currentManifest.state],
			manifestIdentity: manifest,
			manifestCollection,
			repairId: manifest.repairId,
			set: { failure: { at: new Date(), message: String(cause.message).slice(0, 2000) } },
			targetKey: manifest.targetKey,
			toState: state,
		});
		return { classifications: initial, state };
	}
	if (currentManifest.state === "applying") {
		currentManifest = (await transitionManifest({
			applyToken: manifest.applyToken,
			fromStates: ["applying"],
			manifestIdentity: manifest,
			manifestCollection,
			repairId: manifest.repairId,
			set: { failure: { at: new Date(), message: String(cause.message).slice(0, 2000) } },
			targetKey: manifest.targetKey,
			toState: "compensating",
		})).manifest;
	}
	try {
		const statesByKey = new Map(initial.map((entry) => [`${entry.collection}:${entry.documentId}`, entry.state]));
		for (const documentPlan of [...plan.documentPlans].reverse()) {
			if (statesByKey.get(`${documentPlan.collection}:${documentPlan.documentId}`) !== "repaired") continue;
			await assertManifestFence({
				applyToken: manifest.applyToken,
				manifestIdentity: manifest,
				manifestCollection,
				repairId: manifest.repairId,
				states: ["compensating"],
				targetKey: manifest.targetKey,
			});
			const collection = collectionForDocumentPlan(db, documentPlan);
			await executeDocumentWriteWithHashReadback({
				afterHash: documentPlan.originalHash,
				beforeHash: documentPlan.expectedHash,
				db,
				documentPlan,
				write: () => collection.replaceOne(
					buildExactCasFilter(documentPlan.expectedDocument),
					cloneBson(documentPlan.originalDocument),
					writeOptions(),
				),
			});
		}
		const restoredScope = await loadTargetScope({ db, targetKey: plan.targetKey, validateOriginal: true });
		assertEvidenceUnchanged({ plan, scope: restoredScope });
		const restored = assertOriginalMutableDocuments({ plan, scope: restoredScope });
		await transitionManifest({
			applyToken: manifest.applyToken,
			fromStates: ["compensating"],
			manifestIdentity: manifest,
			manifestCollection,
			repairId: manifest.repairId,
			set: { compensatedAt: new Date() },
			targetKey: manifest.targetKey,
			toState: "compensated",
		});
		return { classifications: restored, state: "compensated" };
	} catch (compensationError) {
		const latest = await readManifest(manifestCollection, manifest.repairId);
		if (latest?.state === "compensating") {
			await markManualIntervention({
				fromStates: ["compensating"],
				manifest: latest,
				manifestIdentity: manifest,
				manifestCollection,
				reason: `Exact apply compensation failed: ${compensationError.message}`,
			});
		}
		throw compensationError;
	}
};

const resolveApplyFailure = async ({ db, plan, manifest, cause }) => {
	const manifestCollection = db.collection(MANIFEST_COLLECTION);
	const current = await readManifest(manifestCollection, manifest.repairId);
	if (!current || !manifestIdentityMatches(current, manifest)) {
		throw new Error(`Cannot safely resolve apply failure because manifest ownership changed: ${cause.message}`);
	}
	if (current.state === "applied") {
		const scope = await loadTargetScope({ db, targetKey: plan.targetKey, validateOriginal: false });
		const classifications = assertExpectedMutableDocuments({ plan, scope });
		return { classifications, state: "applied" };
	}
	if (["failed_no_change", "compensated"].includes(current.state)) {
		const scope = await loadTargetScope({ db, targetKey: plan.targetKey, validateOriginal: true });
		assertEvidenceUnchanged({ plan, scope });
		return { classifications: assertOriginalMutableDocuments({ plan, scope }), state: current.state };
	}
	if (["applying", "compensating"].includes(current.state)) {
		return compensateApply({ cause, db, manifest: current, plan });
	}
	if (["initializing", "backed_up"].includes(current.state)) {
		const scope = await loadTargetScope({ db, targetKey: plan.targetKey, validateOriginal: true });
		assertEvidenceUnchanged({ plan, scope });
		const classifications = assertOriginalMutableDocuments({ plan, scope });
		await transitionManifest({
			applyToken: manifest.applyToken,
			fromStates: [current.state],
			manifestIdentity: manifest,
			manifestCollection,
			repairId: manifest.repairId,
			set: { failure: { at: new Date(), message: String(cause.message).slice(0, 2000) } },
			targetKey: manifest.targetKey,
			toState: "failed_no_change",
		});
		return { classifications, state: "failed_no_change" };
	}
	throw new Error(`Apply failure requires manual review; manifest is in ${current.state}: ${cause.message}`);
};

const applyRepair = async ({ db, args, clock = nowIso }) => {
	const repairAt = clock();
	const backupAt = repairAt;
	const context = buildPlanContext({ repairAt, repairId: args.repairId });
	const initialScope = await loadTargetScope({ db, targetKey: args.targetKey, validateOriginal: true });
	const plan = buildPlanForScope({ context, scope: initialScope, targetKey: args.targetKey });
	verifyRecoveryPlan(plan);
	const simulated = applyPlanToScope({ plan, scope: initialScope });
	verifyAppliedTarget({ plan, scope: simulated });
	const records = buildBackupRecordsForPlan({
		backupAt,
		backupCollection: context.backupCollection,
		plan,
		repairId: context.repairId,
	});
	if (!args.apply) {
		return recoveryReport({
			args,
			classifications: classifyPlanScope({ plan, scope: initialScope }),
			extra: { backupDocumentsPlanned: records.length },
			plan,
			state: "dry_run_ready",
			writesPerformed: false,
		});
	}

	const applyToken = randomToken();
	const manifest = buildManifestDocument({ applyToken, backupAt, plan, records });
	const manifestCollection = db.collection(MANIFEST_COLLECTION);
	await claimNewRepair({ manifest, manifestCollection });
	try {
		await createAndVerifyBackup({ context, db, records });
		await transitionManifest({
			applyToken,
			fromStates: ["initializing"],
			manifestIdentity: manifest,
			manifestCollection,
			repairId: context.repairId,
			set: { backupVerifiedAt: new Date() },
			targetKey: args.targetKey,
			toState: "backed_up",
		});

		// This second primary/majority read is intentionally fresh and occurs only
		// after the permanent backup has passed full-document hash readback.
		const freshScope = await loadTargetScope({ db, targetKey: args.targetKey, validateOriginal: true });
		const freshPlan = buildPlanForScope({ context, scope: freshScope, targetKey: args.targetKey });
		comparePlans(plan, freshPlan);
		assertEvidenceUnchanged({ plan, scope: freshScope });
		assertOriginalMutableDocuments({ plan, scope: freshScope });
		await transitionManifest({
			applyToken,
			fromStates: ["backed_up"],
			manifestIdentity: manifest,
			manifestCollection,
			repairId: context.repairId,
			set: { applyStartedAt: new Date() },
			targetKey: args.targetKey,
			toState: "applying",
		});

		for (const documentPlan of plan.documentPlans) {
			await assertManifestFence({
				applyToken,
				manifestIdentity: manifest,
				manifestCollection,
				repairId: context.repairId,
				states: ["applying"],
				targetKey: args.targetKey,
			});
			const collection = collectionForDocumentPlan(db, documentPlan);
			await executeDocumentWriteWithHashReadback({
				afterHash: documentPlan.expectedHash,
				beforeHash: documentPlan.originalHash,
				db,
				documentPlan,
				write: () => collection.updateOne(
					cloneBson(documentPlan.casFilter),
					cloneBson(documentPlan.update),
					writeOptions(),
				),
			});
		}
		const appliedScope = await loadTargetScope({ db, targetKey: args.targetKey, validateOriginal: false });
		const classifications = assertExpectedMutableDocuments({ plan, scope: appliedScope });
		await transitionManifest({
			applyToken,
			fromStates: ["applying"],
			manifestIdentity: manifest,
			manifestCollection,
			repairId: context.repairId,
			set: {
				appliedAt: new Date(),
				appliedHashes: Object.fromEntries(plan.documentPlans.map((entry) => [
					`${entry.collection}:${entry.documentId}`,
					entry.expectedHash,
				])),
			},
			targetKey: args.targetKey,
			toState: "applied",
		});
		return recoveryReport({ args, classifications, plan, state: "applied", writesPerformed: true });
	} catch (error) {
		let resolution;
		try {
			resolution = await resolveApplyFailure({ cause: error, db, manifest, plan });
		} catch (resolutionError) {
			error.recoveryError = resolutionError.message;
			throw error;
		}
		if (resolution.state === "applied") {
			return recoveryReport({
				args,
				classifications: resolution.classifications,
				extra: { acknowledgementRecovered: true },
				plan,
				state: "applied",
				writesPerformed: true,
			});
		}
		error.recoveryState = resolution.state;
		throw error;
	}
};

const originalDocumentFromBackup = ({ records, sourceCollection, sourceDocumentId }) => {
	const matches = records.filter((record) =>
		record.sourceCollection === sourceCollection
		&& String(record.sourceDocumentId).toLowerCase() === String(sourceDocumentId).toLowerCase());
	assert.equal(matches.length, 1, `Backup must contain exactly one ${sourceCollection}/${sourceDocumentId} full document.`);
	return cloneBson(matches[0].originalDocument);
};

const loadManifestAndBackupPlan = async ({ db, repairId, targetKey }) => {
	const manifestCollection = db.collection(MANIFEST_COLLECTION);
	const manifest = await readManifest(manifestCollection, repairId);
	assert.ok(manifest, `Recovery manifest ${repairId} does not exist.`);
	assert.equal(manifest.schemaVersion, MANIFEST_SCHEMA_VERSION, "Unsupported recovery manifest schema.");
	assert.equal(manifest.operation, OPERATION, "Manifest belongs to another operation.");
	assert.equal(manifest.repairId, repairId, "Manifest repairId changed.");
	assert.equal(manifest.targetKey, targetKey, "Manifest belongs to a different target.");
	assert.equal(manifest.backupCollection, buildBackupCollectionName(repairId), "Manifest backup collection changed.");
	const records = await db.collection(manifest.backupCollection)
		.find({}, readOptions())
		.sort({ _id: 1 })
		.toArray();
	verifyBackupRecords({ records, repairId, backupCollection: manifest.backupCollection });
	assert.equal(records.length, manifest.backupRecordCount, "Backup record count differs from the permanent manifest.");
	assert.deepEqual(recordHashMap(records), manifest.backupRecordHashes, "Backup record hashes differ from the permanent manifest.");

	const target = getTarget(targetKey);
	const reservation = target.mongoId
		? originalDocumentFromBackup({
			records,
			sourceCollection: RESERVATION_COLLECTION,
			sourceDocumentId: target.mongoId,
		})
		: null;
	const audits = target.audits.map((audit) => originalDocumentFromBackup({
		records,
		sourceCollection: INBOUND_COLLECTION,
		sourceDocumentId: audit.id,
	}));
	const hotel = target.kind === "hotel_assignment"
		? originalDocumentFromBackup({
			records,
			sourceCollection: HOTEL_COLLECTION,
			sourceDocumentId: target.hotelId,
		})
		: null;
	const context = buildPlanContext({ repairAt: manifest.repairAt, repairId });
	const plan = buildRecoveryPlan({ audits, context, hotel, reservation, targetKey });
	verifyRecoveryPlan(plan);
	assert.equal(planHash(plan), manifest.planHash, "Plan reconstructed from backup differs from the permanent manifest.");
	assert.ok(canonicalEqual(planDescriptor(plan).documents, manifest.documentPlans), "Manifest document-plan descriptors changed.");
	assert.ok(canonicalEqual(planDescriptor(plan).immutableEvidence, manifest.immutableEvidence), "Manifest immutable evidence descriptors changed.");
	assert.ok(canonicalEqual(planDescriptor(plan).hotelEvidence, manifest.hotelEvidence), "Manifest hotel evidence descriptor changed.");
	const plannedRecords = buildBackupRecordsForPlan({
		backupAt: manifest.backupAt,
		backupCollection: manifest.backupCollection,
		plan,
		repairId,
	});
	verifyBackupReadback({
		backupCollection: manifest.backupCollection,
		plannedRecords,
		readback: records,
		repairId,
	});
	return { manifest, manifestCollection, plan, records };
};

const compensateRollback = async ({ db, plan, manifest, rollbackToken, cause }) => {
	const manifestCollection = db.collection(MANIFEST_COLLECTION);
	let currentManifest = await assertManifestFence({
		applyToken: manifest.applyToken,
		manifestIdentity: manifest,
		manifestCollection,
		repairId: manifest.repairId,
		rollbackToken,
		states: ["rolling_back", "rollback_compensating", "rolled_back"],
		targetKey: manifest.targetKey,
	});
	if (currentManifest.state === "rolled_back") {
		const restoredScope = await loadTargetScope({
			db,
			targetKey: plan.targetKey,
			validateOriginal: true,
		});
		assertEvidenceUnchanged({ plan, scope: restoredScope });
		return {
			classifications: assertOriginalMutableDocuments({ plan, scope: restoredScope }),
			state: "rolled_back",
		};
	}
	let scope;
	try {
		scope = await loadTargetScope({ db, targetKey: plan.targetKey, validateOriginal: false });
		assertEvidenceUnchanged({ plan, scope });
	} catch (error) {
		await markManualIntervention({
			fromStates: [currentManifest.state],
			manifest: currentManifest,
			manifestCollection,
			reason: `Rollback compensation preflight failed: ${error.message}`,
		});
		throw error;
	}
	const initial = classifyPlanScope({ plan, scope });
	if (initial.some((entry) => entry.state === "changed_or_missing")) {
		await markManualIntervention({
			fromStates: [currentManifest.state],
			manifest: currentManifest,
			manifestCollection,
			reason: `Unknown live hash during rollback compensation: ${cause.message}`,
		});
		throw new Error("Rollback compensation stopped: at least one mutable document has an unknown shape.");
	}
	if (initial.every((entry) => entry.state === "original")) {
		await transitionManifest({
			applyToken: manifest.applyToken,
			fromStates: [currentManifest.state],
			manifestIdentity: manifest,
			manifestCollection,
			repairId: manifest.repairId,
			rollbackToken,
			set: { rolledBackAt: new Date(), rollbackRecoveredAcknowledgement: true },
			targetKey: manifest.targetKey,
			toState: "rolled_back",
		});
		return { classifications: initial, state: "rolled_back" };
	}
	if (initial.every((entry) => entry.state === "repaired")) {
		await transitionManifest({
			applyToken: manifest.applyToken,
			fromStates: [currentManifest.state],
			manifestIdentity: manifest,
			manifestCollection,
			repairId: manifest.repairId,
			rollbackToken,
			set: { rollbackFailure: { at: new Date(), message: String(cause.message).slice(0, 2000) } },
			targetKey: manifest.targetKey,
			toState: "applied",
			unset: { rollbackToken: "" },
		});
		return { classifications: initial, state: "applied" };
	}
	if (currentManifest.state === "rolling_back") {
		currentManifest = (await transitionManifest({
			applyToken: manifest.applyToken,
			fromStates: ["rolling_back"],
			manifestIdentity: manifest,
			manifestCollection,
			repairId: manifest.repairId,
			rollbackToken,
			set: { rollbackFailure: { at: new Date(), message: String(cause.message).slice(0, 2000) } },
			targetKey: manifest.targetKey,
			toState: "rollback_compensating",
		})).manifest;
	}
	try {
		const statesByKey = new Map(initial.map((entry) => [`${entry.collection}:${entry.documentId}`, entry.state]));
		for (const documentPlan of plan.documentPlans) {
			if (statesByKey.get(`${documentPlan.collection}:${documentPlan.documentId}`) !== "original") continue;
			await assertManifestFence({
				applyToken: manifest.applyToken,
				manifestIdentity: manifest,
				manifestCollection,
				repairId: manifest.repairId,
				rollbackToken,
				states: ["rollback_compensating"],
				targetKey: manifest.targetKey,
			});
			const collection = collectionForDocumentPlan(db, documentPlan);
			await executeDocumentWriteWithHashReadback({
				afterHash: documentPlan.expectedHash,
				beforeHash: documentPlan.originalHash,
				db,
				documentPlan,
				write: () => collection.replaceOne(
					buildExactCasFilter(documentPlan.originalDocument),
					cloneBson(documentPlan.expectedDocument),
					writeOptions(),
				),
			});
		}
		const repairedScope = await loadTargetScope({ db, targetKey: plan.targetKey, validateOriginal: false });
		const repaired = assertExpectedMutableDocuments({ plan, scope: repairedScope });
		await transitionManifest({
			applyToken: manifest.applyToken,
			fromStates: ["rollback_compensating"],
			manifestIdentity: manifest,
			manifestCollection,
			repairId: manifest.repairId,
			rollbackToken,
			set: { rollbackCompensatedAt: new Date() },
			targetKey: manifest.targetKey,
			toState: "applied",
			unset: { rollbackToken: "" },
		});
		return { classifications: repaired, state: "applied" };
	} catch (compensationError) {
		const latest = await readManifest(manifestCollection, manifest.repairId);
		if (latest?.state === "rollback_compensating") {
			await markManualIntervention({
				fromStates: ["rollback_compensating"],
				manifest: latest,
				manifestIdentity: manifest,
				manifestCollection,
				reason: `Exact rollback compensation failed: ${compensationError.message}`,
			});
		}
		throw compensationError;
	}
};

const rollbackRepair = async ({ db, args }) => {
	const loaded = await loadManifestAndBackupPlan({
		db,
		repairId: args.repairId,
		targetKey: args.targetKey,
	});
	const { manifest, manifestCollection, plan } = loaded;
	assert.ok(["applied", "rolled_back"].includes(manifest.state), `Rollback requires an applied manifest; current state is ${manifest.state}.`);
	const liveScope = await loadTargetScope({ db, targetKey: args.targetKey, validateOriginal: false });
	assertEvidenceUnchanged({ plan, scope: liveScope });
	const initial = classifyPlanScope({ plan, scope: liveScope });
	assert.equal(initial.some((entry) => entry.state === "changed_or_missing"), false, "Rollback refused an unknown live document shape.");
	if (manifest.state === "rolled_back") {
		assert.ok(initial.every((entry) => entry.state === "original"), "Rolled-back manifest does not match exact original documents.");
		return recoveryReport({ args, classifications: initial, plan, state: "rolled_back", writesPerformed: false });
	}
	assert.ok(initial.every((entry) => entry.state === "repaired"), "Applied manifest is not in the complete exact repaired state.");
	if (!args.apply) {
		return recoveryReport({ args, classifications: initial, plan, state: "rollback_dry_run_ready", writesPerformed: false });
	}

	const rollbackToken = randomToken();
	const claimed = (await transitionManifest({
		applyToken: manifest.applyToken,
		fromStates: ["applied"],
		manifestIdentity: manifest,
		manifestCollection,
		repairId: manifest.repairId,
		set: { rollbackStartedAt: new Date(), rollbackToken },
		targetKey: manifest.targetKey,
		toState: "rolling_back",
	})).manifest;
	assert.equal(claimed.rollbackToken, rollbackToken, "Rollback token was not durably claimed.");
	try {
		for (const documentPlan of [...plan.documentPlans].reverse()) {
			await assertManifestFence({
				applyToken: manifest.applyToken,
				manifestIdentity: manifest,
				manifestCollection,
				repairId: manifest.repairId,
				rollbackToken,
				states: ["rolling_back"],
				targetKey: manifest.targetKey,
			});
			const collection = collectionForDocumentPlan(db, documentPlan);
			await executeDocumentWriteWithHashReadback({
				afterHash: documentPlan.originalHash,
				beforeHash: documentPlan.expectedHash,
				db,
				documentPlan,
				write: () => collection.replaceOne(
					buildExactCasFilter(documentPlan.expectedDocument),
					cloneBson(documentPlan.originalDocument),
					writeOptions(),
				),
			});
		}
		const restoredScope = await loadTargetScope({ db, targetKey: args.targetKey, validateOriginal: true });
		assertEvidenceUnchanged({ plan, scope: restoredScope });
		const classifications = assertOriginalMutableDocuments({ plan, scope: restoredScope });
		await transitionManifest({
			applyToken: manifest.applyToken,
			fromStates: ["rolling_back"],
			manifestIdentity: manifest,
			manifestCollection,
			repairId: manifest.repairId,
			rollbackToken,
			set: { rolledBackAt: new Date() },
			targetKey: manifest.targetKey,
			toState: "rolled_back",
		});
		return recoveryReport({ args, classifications, plan, state: "rolled_back", writesPerformed: true });
	} catch (error) {
		let resolution;
		try {
			resolution = await compensateRollback({
				cause: error,
				db,
				manifest: claimed,
				plan,
				rollbackToken,
			});
		} catch (resolutionError) {
			error.recoveryError = resolutionError.message;
			throw error;
		}
		if (resolution.state === "rolled_back") {
			return recoveryReport({
				args,
				classifications: resolution.classifications,
				extra: { acknowledgementRecovered: true },
				plan,
				state: "rolled_back",
				writesPerformed: true,
			});
		}
		error.recoveryState = resolution.state;
		throw error;
	}
};

const connectDatabase = async () => {
	const database = process.env.DATABASE || process.env.MONGO_URI || process.env.MONGODB_URI;
	assert.ok(database, "DATABASE, MONGO_URI, or MONGODB_URI is required.");
	await mongoose.connect(database, {
		autoIndex: false,
		readConcern: { level: "majority" },
		readPreference: "primary",
	});
	assert.ok(mongoose.connection.db, "MongoDB connection did not expose a database handle.");
	return mongoose.connection.db;
};

const main = async (argv = process.argv.slice(2), dependencies = {}) => {
	const args = parseArguments(argv);
	if (args.help) return { help: true, usage: usage() };
	let db = dependencies.db;
	let ownsConnection = false;
	if (!db) {
		const connect = dependencies.connectDatabase || connectDatabase;
		db = await connect();
		ownsConnection = true;
	}
	try {
		if (args.rollback) return await rollbackRepair({ args, db });
		const effectiveArgs = {
			...args,
			repairId: args.repairId || `dryrun:${args.targetKey}`,
		};
		return await applyRepair({
			args: effectiveArgs,
			clock: dependencies.clock || nowIso,
			db,
		});
	} finally {
		if (ownsConnection) {
			const disconnect = dependencies.disconnect || (() => mongoose.disconnect());
			await disconnect();
		}
	}
};

const runCli = async () => {
	try {
		const result = await main();
		if (result.help) process.stdout.write(`${result.usage}\n`);
		else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	} catch (error) {
		const details = {
			error: error.message,
			recoveryError: error.recoveryError || "",
			recoveryState: error.recoveryState || "",
			writesMayHaveOccurred: process.argv.includes("--apply"),
		};
		process.stderr.write(`${JSON.stringify(details, null, 2)}\n`);
		process.exitCode = 1;
	}
};

if (require.main === module) {
	runCli();
}

module.exports = {
	INBOUND_COLLECTION,
	HOTEL_COLLECTION,
	MANIFEST_SCHEMA_VERSION,
	PRIMARY_MAJORITY_READ,
	RESERVATION_COLLECTION,
	applyRepair,
	assertEvidenceUnchanged,
	assertExactAuditScope,
	assertManifestImmutableIdentity,
	assertManifestFence,
	buildAuditMatchQuery,
	buildBackupRecordsForPlan,
	buildManifestDocument,
	buildPlanContext,
	claimNewRepair,
	collectionForDocumentPlan,
	comparePlans,
	compensateApply,
	compensateRollback,
	connectDatabase,
	createAndVerifyBackup,
	executeDocumentWriteWithHashReadback,
	loadManifestAndBackupPlan,
	loadTargetScope,
	main,
	manifestImmutableFilter,
	parseArguments,
	planDescriptor,
	planHash,
	recordHashMap,
	rollbackRepair,
	runCli,
	transitionManifest,
	usage,
	verifyBackupReadback,
};
