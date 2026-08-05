/**
 * Targeted repair for exactly these two incident reservations:
 *   PMS 8234871006 / Mongo 6a727710c0900e055a1b83ba
 *   PMS 9764914393 / Mongo 6a7289cbc0900e055a1b8b9e
 *
 * The separate, manually handled PMS 7043857218 case is explicitly excluded.
 * This utility never parses or replays stored email bodies. Its commercial
 * facts and evidence IDs come from the completed forensic review.
 *
 * Repair dry run (default, no writes):
 *   node scripts/repairTripHotelRunnerReservations20260805.js
 *
 * Apply only after reviewing a fresh dry run:
 *   node scripts/repairTripHotelRunnerReservations20260805.js \
 *     --apply --repair-id trip-20260805-<unique-change-id>
 *
 * Rollback dry run:
 *   node scripts/repairTripHotelRunnerReservations20260805.js \
 *     --rollback --repair-id trip-20260805-<same-change-id>
 *
 * Conditional rollback apply:
 *   node scripts/repairTripHotelRunnerReservations20260805.js \
 *     --rollback --apply --repair-id trip-20260805-<same-change-id>
 */

"use strict";

require("dotenv").config();

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const mongoose = require("mongoose");

mongoose.set("strictQuery", true);
mongoose.set("autoCreate", false);

const InboundEmail = require("../models/inbound_email");
const Reservations = require("../models/reservations");
const {
	ALL_AUDIT_IDS,
	EXCLUDED_PMS_CONFIRMATION,
	MANIFEST_COLLECTION,
	OPERATION,
	TARGETS,
	buildBackupCollectionName,
	buildBackupRecords,
	buildDryRunReport,
	buildExactCasFilter,
	buildRepairPlans,
	canonicalEjsonSha256,
	canonicalEqual,
	cloneBson,
	id,
	parseCliArguments,
	transactionSupportFromHello,
	validateAuditSet,
	verifyBackupRecords,
	verifyRepairedDocument,
} = require("../services/tripHotelRunnerRepair20260805");

const RESERVATION_COLLECTION = "reservations";
const INBOUND_COLLECTION = "inboundemails";
const MAJORITY_WRITE_CONCERN = Object.freeze({ w: "majority" });
const CROSS_TRANSPORT_INDEX_NAME = "uniq_ota_cross_transport_identity_key";
const CROSS_TRANSPORT_INDEX_KEY = Object.freeze({
	otaCrossTransportIdentityKey: 1,
});
const CROSS_TRANSPORT_INDEX_PARTIAL = Object.freeze({
	otaCrossTransportIdentityKey: { $type: "string", $gt: "" },
});

const PRIMARY_MAJORITY_READ = Object.freeze({
	readPreference: "primary",
	readConcern: Object.freeze({ level: "majority" }),
});

const usage = () => [
	"Usage:",
	"  node scripts/repairTripHotelRunnerReservations20260805.js [--repair-id <id>]",
	"  node scripts/repairTripHotelRunnerReservations20260805.js --apply --repair-id <id>",
	"  node scripts/repairTripHotelRunnerReservations20260805.js --rollback --repair-id <id>",
	"  node scripts/repairTripHotelRunnerReservations20260805.js --rollback --apply --repair-id <id>",
	"",
	"Dry-run is the default. Database writes require both --apply and --repair-id.",
	`Scope is fixed to PMS ${TARGETS.map((target) => target.pmsConfirmation).join(" and ")}; PMS ${EXCLUDED_PMS_CONFIRMATION} is excluded.`,
].join("\n");

const objectId = (value) => new mongoose.Types.ObjectId(String(value));
const queryOptions = (session, additions = {}) =>
	session
		? { session, readPreference: "primary", ...additions }
		: {
				readPreference: PRIMARY_MAJORITY_READ.readPreference,
				readConcern: { ...PRIMARY_MAJORITY_READ.readConcern },
				...additions,
		  };
const writeOptions = (session) =>
	session
		? { session }
		: { writeConcern: { ...MAJORITY_WRITE_CONCERN } };

const assertManifestFence = async ({
	manifestCollection,
	repairId,
	state,
	operationToken = "",
	tokenField = "",
	session = null,
}) => {
	const filter = { _id: repairId, state };
	if (tokenField) {
		assert.ok(operationToken, "A manifest operation token is required.");
		filter[tokenField] = operationToken;
	}
	const current = await manifestCollection.findOne(
		filter,
		{
			...queryOptions(session),
			projection: { _id: 1 },
		},
	);
	assert.ok(
		current,
		`Manifest ownership fence was lost for ${repairId}; no reservation write is allowed.`,
	);
	return true;
};

const scopeIds = () => ({
	reservationIds: TARGETS.map((target) => objectId(target.mongoId)),
	auditIds: ALL_AUDIT_IDS.map(objectId),
});

const loadScope = async ({
	session = null,
	reservationCollection = Reservations.collection,
	inboundCollection = InboundEmail.collection,
} = {}) => {
	const { reservationIds, auditIds } = scopeIds();
	// MongoDB drivers prohibit concurrent operations on the same transaction
	// session. Keep both reads serial even though non-transactional callers could
	// technically parallelize them; the scope contains only eight fixed IDs.
	const reservations = await reservationCollection
		.find({ _id: { $in: reservationIds } }, queryOptions(session))
		.toArray();
	const audits = await inboundCollection
		.find({ _id: { $in: auditIds } }, queryOptions(session))
		.toArray();
	assert.equal(reservations.length, 2, "The exact two target reservations were not found.");
	assert.equal(audits.length, 6, "The exact six evidence audits were not found.");
	assert.equal(
		reservations.some(
			(reservation) =>
				String(reservation.confirmation_number || "") ===
				EXCLUDED_PMS_CONFIRMATION,
		),
		false,
		`Excluded PMS ${EXCLUDED_PMS_CONFIRMATION} entered the loaded scope.`,
	);
	validateAuditSet(audits);
	return { reservations, audits };
};

const assertCrossTransportIndexDefinition = (index) => {
	assert.ok(index, `${CROSS_TRANSPORT_INDEX_NAME} is missing.`);
	assert.equal(index.name, CROSS_TRANSPORT_INDEX_NAME, "Bridge index name changed.");
	assert.ok(
		canonicalEqual(index.key, CROSS_TRANSPORT_INDEX_KEY),
		"Bridge index key specification changed.",
	);
	assert.equal(index.unique, true, "Bridge index must be unique.");
	assert.ok(
		canonicalEqual(
			index.partialFilterExpression,
			CROSS_TRANSPORT_INDEX_PARTIAL,
		),
		"Bridge index partial filter changed.",
	);
	return true;
};

const inspectCrossTransportIndex = async ({
	reservationCollection = Reservations.collection,
	targetClaimState = "none",
} = {}) => {
	assert.ok(
		["none", "repaired"].includes(targetClaimState),
		"Unknown bridge target-claim state.",
	);
	const indexes = await reservationCollection
		.listIndexes(queryOptions())
		.toArray();
	const named = indexes.find(
		(index) => index.name === CROSS_TRANSPORT_INDEX_NAME,
	);
	const sameKey = indexes.filter((index) =>
		canonicalEqual(index.key, CROSS_TRANSPORT_INDEX_KEY),
	);
	if (named) assertCrossTransportIndexDefinition(named);
	if (!named && sameKey.length) {
		throw new Error(
			`A differently named otaCrossTransportIdentityKey index already exists (${sameKey
				.map((index) => index.name)
				.join(", ")}); refusing to drop or replace it automatically.`,
		);
	}

	const duplicateKeys = await reservationCollection
		.aggregate(
			[
				{
					$match: {
						otaCrossTransportIdentityKey: {
							$type: "string",
							$gt: "",
						},
					},
				},
				{
					$group: {
						_id: "$otaCrossTransportIdentityKey",
						count: { $sum: 1 },
					},
				},
				{ $match: { count: { $gt: 1 } } },
				{ $limit: 5 },
			],
			queryOptions(null, { allowDiskUse: false }),
		)
		.toArray();
	assert.equal(
		duplicateKeys.length,
		0,
		"Duplicate non-empty otaCrossTransportIdentityKey values block the unique bridge index.",
	);

	const targetKeys = TARGETS.map(
		(target) => target.crossTransportIdentityKey,
	);
	const targetClaims = await reservationCollection
		.find(
			{ otaCrossTransportIdentityKey: { $in: targetKeys } },
			queryOptions(null, {
				projection: {
					_id: 1,
					confirmation_number: 1,
					otaCrossTransportIdentityKey: 1,
				},
			}),
		)
		.toArray();
	if (targetClaimState === "none") {
		assert.equal(
			targetClaims.length,
			0,
			"A target Trip bridge identity is already claimed; repair is blocked.",
		);
	} else {
		assert.equal(
			targetClaims.length,
			TARGETS.length,
			"Both repaired reservations must own their target Trip bridge identities.",
		);
		const claimsByKey = new Map(
			targetClaims.map((claim) => [
				String(claim.otaCrossTransportIdentityKey || ""),
				claim,
			]),
		);
		for (const target of TARGETS) {
			const claim = claimsByKey.get(target.crossTransportIdentityKey);
			assert.equal(
				id(claim),
				target.mongoId,
				`Bridge identity ${target.crossTransportIdentityKey} has the wrong owner.`,
			);
			assert.equal(
				String(claim.confirmation_number || ""),
				target.pmsConfirmation,
				`Bridge identity ${target.crossTransportIdentityKey} has the wrong PMS confirmation.`,
			);
		}
	}

	return {
		name: CROSS_TRANSPORT_INDEX_NAME,
		present: Boolean(named),
		valid: Boolean(named),
		wouldCreate: !named,
		unique: named ? true : null,
		partialFilterExpression: cloneBson(CROSS_TRANSPORT_INDEX_PARTIAL),
		globalDuplicateKeysFound: 0,
		targetClaimsVerified: targetClaims.length,
	};
};

const ensureCrossTransportIndex = async ({
	reservationCollection = Reservations.collection,
} = {}) => {
	const before = await inspectCrossTransportIndex({
		reservationCollection,
		targetClaimState: "none",
	});
	let created = false;
	if (!before.present) {
		try {
			await reservationCollection.createIndex(
				CROSS_TRANSPORT_INDEX_KEY,
				{
					name: CROSS_TRANSPORT_INDEX_NAME,
					unique: true,
					partialFilterExpression: CROSS_TRANSPORT_INDEX_PARTIAL,
					writeConcern: { ...MAJORITY_WRITE_CONCERN },
				},
			);
			created = true;
		} catch (error) {
			// A concurrent exact index creation is safe. Anything else will fail the
			// mandatory readback below, after which the original error is retained.
			try {
				const raced = await inspectCrossTransportIndex({
					reservationCollection,
					targetClaimState: "none",
				});
				if (!raced.present) throw error;
			} catch (verificationError) {
				if (verificationError === error) throw error;
				throw new Error(
					`Bridge index creation failed (${error.message}); readback also failed (${verificationError.message}).`,
				);
			}
		}
	}
	const after = await inspectCrossTransportIndex({
		reservationCollection,
		targetClaimState: "none",
	});
	assert.equal(after.present, true, "Bridge index creation was not durable.");
	return { ...after, created, wouldCreate: false };
};

const contextFromManifest = (manifest) => ({
	repairId: String(manifest._id),
	repairAt: new Date(manifest.repairAt),
	backupCollection: String(manifest.backupCollection),
});

const validateManifest = (manifest, repairId) => {
	assert.ok(manifest, `No repair manifest exists for ${repairId}.`);
	assert.equal(String(manifest._id), repairId, "Repair manifest ID changed.");
	assert.equal(manifest.operation, OPERATION, "Repair manifest operation changed.");
	assert.ok(!Number.isNaN(new Date(manifest.repairAt).getTime()), "Repair manifest repairAt is invalid.");
	assert.ok(!Number.isNaN(new Date(manifest.backupAt).getTime()), "Repair manifest backupAt is invalid.");
	assert.equal(
		String(manifest.backupCollection || ""),
		buildBackupCollectionName(repairId, manifest.repairAt),
		"Repair manifest names an invalid backup collection.",
	);
	assert.deepEqual(
		manifest.scope?.pmsConfirmations,
		TARGETS.map((target) => target.pmsConfirmation),
		"Repair manifest PMS scope changed.",
	);
	assert.deepEqual(
		manifest.scope?.reservationMongoIds,
		TARGETS.map((target) => target.mongoId),
		"Repair manifest reservation scope changed.",
	);
	assert.deepEqual(
		manifest.scope?.inboundAuditIds,
		ALL_AUDIT_IDS,
		"Repair manifest audit scope changed.",
	);
	assert.equal(
		manifest.scope?.excludedPmsConfirmation,
		EXCLUDED_PMS_CONFIRMATION,
		"Repair manifest exclusion changed.",
	);
	return manifest;
};

const manifestScope = () => ({
	pmsConfirmations: TARGETS.map((target) => target.pmsConfirmation),
	reservationMongoIds: TARGETS.map((target) => target.mongoId),
	inboundAuditIds: ALL_AUDIT_IDS,
	excludedPmsConfirmation: EXCLUDED_PMS_CONFIRMATION,
});

const getOrCreateManifest = async ({ db, repairId, now }) => {
	const manifests = db.collection(MANIFEST_COLLECTION);
	const existing = await manifests.findOne(
		{ _id: repairId },
		queryOptions(),
	);
	if (existing) return validateManifest(existing, repairId);

	const manifest = {
		_id: repairId,
		operation: OPERATION,
		state: "initializing",
		backupCollection: buildBackupCollectionName(repairId, now),
		repairAt: new Date(now),
		backupAt: new Date(now),
		scope: manifestScope(),
		createdAt: new Date(now),
		updatedAt: new Date(now),
	};
	try {
		await manifests.insertOne(manifest, writeOptions());
		return manifest;
	} catch (error) {
		if (error?.code !== 11000) throw error;
		const raced = await manifests.findOne(
			{ _id: repairId },
			queryOptions(),
		);
		return validateManifest(raced, repairId);
	}
};

const backupKey = (record) =>
	`${record.sourceCollection}:${id(record.originalId)}`;

const comparePlannedAndSavedBackups = (planned, saved) => {
	const plannedByKey = new Map(planned.map((record) => [backupKey(record), record]));
	for (const record of saved) {
		const expected = plannedByKey.get(backupKey(record));
		assert.ok(expected, `Unexpected backup record ${backupKey(record)}.`);
		const withoutStorageId = (value) => {
			const comparable = cloneBson(value);
			delete comparable._id;
			return comparable;
		};
		assert.ok(
			canonicalEqual(
				withoutStorageId(record),
				withoutStorageId(expected),
			),
			`${backupKey(record)} backup wrapper, hashes, evidence IDs, or original document changed.`,
		);
	}
	assert.equal(saved.length, planned.length, "Saved backup count changed.");
};

const ensureBackup = async ({ db, manifest, plans, audits }) => {
	const context = contextFromManifest(manifest);
	const backupCollection = db.collection(context.backupCollection);
	const foreignCount = await backupCollection.countDocuments(
		{ repairId: { $ne: context.repairId } },
		queryOptions(),
	);
	assert.equal(foreignCount, 0, "Backup collection contains a different repair ID.");
	await backupCollection.createIndex(
		{ repairId: 1, sourceCollection: 1, originalId: 1 },
		{
			unique: true,
			name: "uniq_repair_source_original",
			writeConcern: { ...MAJORITY_WRITE_CONCERN },
		},
	);

	const planned = buildBackupRecords({
		plans,
		audits,
		repairId: context.repairId,
		backupCollection: context.backupCollection,
		backupAt: manifest.backupAt,
	});
	for (const record of planned) {
		const filter = {
			repairId: record.repairId,
			sourceCollection: record.sourceCollection,
			originalId: record.originalId,
		};
		const existing = await backupCollection.findOne(
			filter,
			queryOptions(),
		);
		if (existing) {
			comparePlannedAndSavedBackups([record], [existing]);
			continue;
		}
		try {
			await backupCollection.insertOne(record, writeOptions());
		} catch (error) {
			if (error?.code !== 11000) throw error;
			const raced = await backupCollection.findOne(
				filter,
				queryOptions(),
			);
			comparePlannedAndSavedBackups([record], [raced]);
		}
	}

	const saved = await backupCollection
		.find({ repairId: context.repairId }, queryOptions())
		.toArray();
	verifyBackupRecords({
		records: saved,
		repairId: context.repairId,
		backupCollection: context.backupCollection,
	});
	comparePlannedAndSavedBackups(planned, saved);

	const manifests = db.collection(MANIFEST_COLLECTION);
	if (manifest.state === "initializing") {
		const result = await manifests.updateOne(
			{ _id: context.repairId, state: "initializing" },
			{
				$set: {
					state: "backed_up",
					backupVerifiedAt: new Date(),
					backupDocumentCount: 8,
					reservationOriginalHashes: plans.map((plan) => ({
						reservationMongoId: plan.target.mongoId,
						originalHash: plan.originalHash,
						expectedRepairedHash: plan.expectedHash,
					})),
					updatedAt: new Date(),
				},
			},
			writeOptions(),
		);
		assert.equal(result.matchedCount, 1, "Manifest changed while verifying the backup.");
		manifest.state = "backed_up";
	}
	assert.equal(manifest.state, "backed_up", `Repair manifest state ${manifest.state} is not applyable. Use a new repair ID or inspect/rollback the existing run.`);
	return saved;
};

const backupRecordsBySource = (backupRecords, sourceCollection) =>
	new Map(
		backupRecords
			.filter((record) => record.sourceCollection === sourceCollection)
			.map((record) => [id(record.originalId), record]),
	);

const assertLiveScopeMatchesOriginalBackup = ({ scope, backupRecords }) => {
	const reservationBackups = backupRecordsBySource(
		backupRecords,
		RESERVATION_COLLECTION,
	);
	const auditBackups = backupRecordsBySource(backupRecords, INBOUND_COLLECTION);
	for (const reservation of scope.reservations) {
		const backup = reservationBackups.get(id(reservation));
		assert.ok(backup, `Missing reservation backup ${id(reservation)}.`);
		assert.equal(
			canonicalEjsonSha256(reservation),
			backup.originalHash,
			`Reservation ${id(reservation)} changed after backup; no repair is allowed.`,
		);
	}
	for (const audit of scope.audits) {
		const backup = auditBackups.get(id(audit));
		assert.ok(backup, `Missing audit backup ${id(audit)}.`);
		assert.equal(
			canonicalEjsonSha256(audit),
			backup.originalHash,
			`Inbound audit ${id(audit)} changed after backup; no repair is allowed.`,
		);
	}
	return true;
};

const assertPlansMatchBackups = (plans, backupRecords) => {
	const backups = backupRecordsBySource(backupRecords, RESERVATION_COLLECTION);
	for (const plan of plans) {
		const backup = backups.get(plan.target.mongoId);
		assert.ok(backup, `Missing backup for ${plan.target.mongoId}.`);
		assert.equal(plan.originalHash, backup.originalHash, "Plan original hash differs from backup.");
		assert.equal(plan.expectedHash, backup.expectedRepairedHash, "Plan expected repair hash differs from backup.");
	}
	return true;
};

const readBackupsForManifest = async ({ db, manifest }) => {
	validateManifest(manifest, String(manifest._id));
	const backupCollection = db.collection(manifest.backupCollection);
	const records = await backupCollection
		.find({ repairId: String(manifest._id) }, queryOptions())
		.toArray();
	verifyBackupRecords({
		records,
		repairId: String(manifest._id),
		backupCollection: manifest.backupCollection,
	});
	return records;
};

const transactionSupported = async (db) => {
	const hello = await db.admin().command(
		{ hello: 1 },
		{ readPreference: "primary" },
	);
	return transactionSupportFromHello(hello);
};

const rollbackClaimStates = (manifest) => {
	const states = [
		"applied",
		"backed_up",
		"rollback_required",
		"rollback_failed_restored",
		"rollback_partial_manual_intervention",
		"apply_failed_rolled_back",
		"rolled_back",
	];
	if (["applying", "rolling_back"].includes(manifest.state)) {
		throw new Error(
			`Manifest ${manifest._id || ""} is ${manifest.state}. Automatic takeover is permanently disabled because a paused writer could resume. Stop all repair processes and use a reviewed manual recovery procedure.`,
		);
	}
	return states;
};

const rollbackManifestClaimFilter = (manifest, allowedManifestStates) => {
	return {
		_id: String(manifest._id),
		state: { $in: allowedManifestStates },
	};
};

const updateOnePlan = async ({
	plan,
	session = null,
	reservationCollection = Reservations.collection,
	beforeWrite = null,
}) => {
	if (beforeWrite) await beforeWrite();
	const result = await reservationCollection.updateOne(
		plan.casFilter,
		plan.update,
		writeOptions(session),
	);
	assert.equal(result.matchedCount, 1, `CAS filter did not match PMS ${plan.target.pmsConfirmation}.`);
	assert.equal(result.modifiedCount, 1, `CAS update did not modify PMS ${plan.target.pmsConfirmation}.`);
	const saved = await reservationCollection.findOne(
		{ _id: objectId(plan.target.mongoId) },
		queryOptions(session),
	);
	assert.equal(
		canonicalEjsonSha256(saved),
		plan.expectedHash,
		`PMS ${plan.target.pmsConfirmation} does not equal the deterministic repaired document.`,
	);
	verifyRepairedDocument({
		before: plan.originalDocument,
		after: saved,
		target: plan.target,
		context: {
			repairId: plan.update.$push.reservationAuditLog.repairId,
			repairAt: plan.update.$set.updatedAt,
			backupCollection:
				plan.update.$push.reservationAuditLog.backupCollection,
		},
	});
	return saved;
};

const verifyAppliedScope = ({ scope, plans, backupRecords, context }) => {
	const byId = new Map(scope.reservations.map((reservation) => [id(reservation), reservation]));
	for (const plan of plans) {
		const saved = byId.get(plan.target.mongoId);
		assert.ok(saved, `Postverify cannot find ${plan.target.mongoId}.`);
		assert.equal(canonicalEjsonSha256(saved), plan.expectedHash, `Postverify hash failed for PMS ${plan.target.pmsConfirmation}.`);
		verifyRepairedDocument({
			before: plan.originalDocument,
			after: saved,
			target: plan.target,
			context,
		});
	}
	const auditBackups = backupRecordsBySource(backupRecords, INBOUND_COLLECTION);
	for (const audit of scope.audits) {
		const backup = auditBackups.get(id(audit));
		assert.ok(backup, `Postverify cannot find backup for audit ${id(audit)}.`);
		assert.equal(canonicalEjsonSha256(audit), backup.originalHash, `Historical inbound audit ${id(audit)} changed.`);
	}
	return true;
};

const appliedResultRows = (plans) =>
	plans.map((plan) => ({
		pmsConfirmation: plan.target.pmsConfirmation,
		reservationMongoId: plan.target.mongoId,
		otaConfirmation: plan.target.otaConfirmation,
		originalHash: plan.originalHash,
		repairedHash: plan.expectedHash,
		casMatched: 1,
		casModified: 1,
		postverified: true,
	}));

const applyInTransaction = async ({ db, manifest, backupRecords }) => {
	const context = contextFromManifest(manifest);
	const manifestCollection = db.collection(MANIFEST_COLLECTION);
	const session = await mongoose.startSession();
	let plans = [];
	try {
		await session.withTransaction(
			async () => {
				const scope = await loadScope({ session });
				assertLiveScopeMatchesOriginalBackup({ scope, backupRecords });
				plans = buildRepairPlans({
					reservations: scope.reservations,
					audits: scope.audits,
					context,
				});
				assertPlansMatchBackups(plans, backupRecords);
				for (const plan of plans) {
					// Intentionally serial: each exact CAS and post-read must pass before
					// the transaction can proceed to the second target.
					// eslint-disable-next-line no-await-in-loop
					await updateOnePlan({
						plan,
						session,
						beforeWrite: () =>
							assertManifestFence({
								manifestCollection,
								repairId: context.repairId,
								state: "backed_up",
								session,
							}),
					});
				}
				const postScope = await loadScope({ session });
				verifyAppliedScope({ scope: postScope, plans, backupRecords, context });
				await assertManifestFence({
					manifestCollection,
					repairId: context.repairId,
					state: "backed_up",
					session,
				});
				const manifestResult = await manifestCollection.updateOne(
					{ _id: context.repairId, state: "backed_up" },
					{
						$set: {
							state: "applied",
							appliedAt: new Date(),
							transactionUsed: true,
							repairedHashes: plans.map((plan) => ({
								reservationMongoId: plan.target.mongoId,
								hash: plan.expectedHash,
							})),
							updatedAt: new Date(),
						},
					},
					{ session },
				);
				assert.equal(manifestResult.matchedCount, 1, "Manifest changed during the repair transaction.");
			},
			{
				readConcern: { level: "snapshot" },
				writeConcern: { w: "majority" },
				readPreference: "primary",
			},
		);
	} finally {
		await session.endSession();
	}
	return plans;
};

const restoreOriginalDocuments = async ({
	plans,
	reservationCollection = Reservations.collection,
	beforeWrite = null,
}) => {
	const restored = [];
	for (const plan of [...plans].reverse()) {
		const current = await reservationCollection.findOne(
			{ _id: objectId(plan.target.mongoId) },
			queryOptions(),
		);
		const currentHash = canonicalEjsonSha256(current);
		if (currentHash === plan.originalHash) continue;
		assert.equal(
			currentHash,
			plan.expectedHash,
			`Cannot compensate PMS ${plan.target.pmsConfirmation}: current document is neither the original nor the exact repaired document.`,
		);
		if (beforeWrite) await beforeWrite();
		const result = await reservationCollection.replaceOne(
			buildExactCasFilter(plan.expectedDocument),
			cloneBson(plan.originalDocument),
			writeOptions(),
		);
		assert.equal(result.matchedCount, 1, `Conditional compensation did not match PMS ${plan.target.pmsConfirmation}.`);
		assert.equal(result.modifiedCount, 1, `Conditional compensation did not restore PMS ${plan.target.pmsConfirmation}.`);
		restored.push(plan.target.pmsConfirmation);
	}
	for (const plan of plans) {
		const saved = await reservationCollection.findOne(
			{ _id: objectId(plan.target.mongoId) },
			queryOptions(),
		);
		assert.equal(canonicalEjsonSha256(saved), plan.originalHash, `Compensation verification failed for PMS ${plan.target.pmsConfirmation}.`);
	}
	return restored;
};

const applyWithoutTransaction = async ({
	db,
	manifest,
	backupRecords,
	reservationCollection = Reservations.collection,
	inboundCollection = InboundEmail.collection,
}) => {
	const context = contextFromManifest(manifest);
	const manifests = db.collection(MANIFEST_COLLECTION);
	const applyOperationToken = crypto.randomUUID();
	const state = await manifests.updateOne(
		{ _id: context.repairId, state: "backed_up" },
		{
			$set: {
				state: "applying",
				applyOperationToken,
				applyStartedAt: new Date(),
				transactionUsed: false,
				updatedAt: new Date(),
			},
		},
		writeOptions(),
	);
	assert.equal(state.matchedCount, 1, "Manifest changed before non-transactional apply.");
	const assertApplyFence = () =>
		assertManifestFence({
			manifestCollection: manifests,
			repairId: context.repairId,
			state: "applying",
			operationToken: applyOperationToken,
			tokenField: "applyOperationToken",
		});

	let plans = [];
	try {
		const scope = await loadScope({
			reservationCollection,
			inboundCollection,
		});
		assertLiveScopeMatchesOriginalBackup({ scope, backupRecords });
		plans = buildRepairPlans({
			reservations: scope.reservations,
			audits: scope.audits,
			context,
		});
		assertPlansMatchBackups(plans, backupRecords);
		for (const plan of plans) {
			// Intentionally serial to allow immediate verification and exact
			// compensation if the second target cannot be changed.
			// eslint-disable-next-line no-await-in-loop
			await updateOnePlan({
				plan,
				reservationCollection,
				beforeWrite: assertApplyFence,
			});
		}
		const postScope = await loadScope({
			reservationCollection,
			inboundCollection,
		});
		verifyAppliedScope({ scope: postScope, plans, backupRecords, context });
		await assertApplyFence();
		const applied = await manifests.updateOne(
			{
				_id: context.repairId,
				state: "applying",
				applyOperationToken,
			},
			{
				$set: {
					state: "applied",
					appliedAt: new Date(),
					repairedHashes: plans.map((plan) => ({
						reservationMongoId: plan.target.mongoId,
						hash: plan.expectedHash,
					})),
					updatedAt: new Date(),
				},
			},
			writeOptions(),
		);
		assert.equal(applied.matchedCount, 1, "Manifest did not finalize after repair.");
		return plans;
	} catch (error) {
		let rollbackError = null;
		try {
			if (!plans.length) {
				const backups = backupRecordsBySource(
					backupRecords,
					RESERVATION_COLLECTION,
				);
				const originals = TARGETS.map((target) => backups.get(target.mongoId)?.originalDocument);
				const audits = backupRecords
					.filter((record) => record.sourceCollection === INBOUND_COLLECTION)
					.map((record) => record.originalDocument);
				plans = buildRepairPlans({ reservations: originals, audits, context });
			}
			await restoreOriginalDocuments({
				plans,
				reservationCollection,
				beforeWrite: assertApplyFence,
			});
		} catch (compensationError) {
			rollbackError = compensationError;
		}
		const failureState = await manifests.updateOne(
			{
				_id: context.repairId,
				state: { $in: ["applying", "applied"] },
				applyOperationToken,
			},
			{
				$set: {
					state: rollbackError
						? "rollback_required"
						: "apply_failed_rolled_back",
					applyError: String(error?.message || error).slice(0, 1000),
					compensationError: rollbackError
						? String(rollbackError?.message || rollbackError).slice(0, 1000)
						: "",
					updatedAt: new Date(),
				},
			},
			writeOptions(),
		);
		assert.equal(
			failureState.matchedCount,
			1,
			"Manifest changed while recording the compensated apply failure.",
		);
		if (rollbackError) {
			throw new Error(
				`Repair failed and exact automatic compensation was blocked: ${error.message}; compensation: ${rollbackError.message}`,
			);
		}
		throw new Error(`Repair failed; every changed reservation was conditionally restored from the verified backup: ${error.message}`);
	}
};

const postverifyApplied = async ({ db, manifest, plans, backupRecords }) => {
	const context = contextFromManifest(manifest);
	const scope = await loadScope();
	verifyAppliedScope({ scope, plans, backupRecords, context });
	await inspectCrossTransportIndex({ targetClaimState: "repaired" });
	const readback = await readBackupsForManifest({ db, manifest });
	// Collection reads do not promise a stable row order. Compare each verified
	// backup by its source/original key rather than hashing the result array.
	comparePlannedAndSavedBackups(backupRecords, readback);
	const savedManifest = await db.collection(MANIFEST_COLLECTION).findOne(
		{ _id: context.repairId },
		queryOptions(),
	);
	assert.equal(savedManifest?.state, "applied", "Repair manifest is not applied after postverify.");
	return scope;
};

const executeApply = async ({ db, repairId }) => {
	const initialScope = await loadScope();
	const now = new Date();
	const proposedContext = {
		repairId,
		repairAt: now,
		backupCollection: buildBackupCollectionName(repairId, now),
	};
	// Validate every source fact before the first write (the manifest/backup).
	buildRepairPlans({
		reservations: initialScope.reservations,
		audits: initialScope.audits,
		context: proposedContext,
	});
	// Read-only global/index preflight happens before even the manifest write.
	await inspectCrossTransportIndex({ targetClaimState: "none" });

	const manifest = await getOrCreateManifest({ db, repairId, now });
	if (!["initializing", "backed_up"].includes(manifest.state)) {
		throw new Error(
			`Repair ID ${repairId} is already in state ${manifest.state}. Do not reuse it; inspect or run a rollback dry run.`,
		);
	}
	const context = contextFromManifest(manifest);
	const plans = buildRepairPlans({
		reservations: initialScope.reservations,
		audits: initialScope.audits,
		context,
	});
	const backupRecords = await ensureBackup({
		db,
		manifest,
		plans,
		audits: initialScope.audits,
	});

	// The backup must be read back and every live source must remain byte-value
	// equivalent under canonical EJSON before either reservation can change.
	const preApplyScope = await loadScope();
	assertLiveScopeMatchesOriginalBackup({
		scope: preApplyScope,
		backupRecords,
	});
	const bridgeIndex = await ensureCrossTransportIndex();
	const bridgeIndexManifest = await db
		.collection(MANIFEST_COLLECTION)
		.updateOne(
			{ _id: context.repairId, state: "backed_up" },
			{
				$set: {
					bridgeIndex: {
						name: bridgeIndex.name,
						unique: true,
						partialFilterExpression: cloneBson(
							CROSS_TRANSPORT_INDEX_PARTIAL,
						),
						createdByRepair: bridgeIndex.created,
					},
					bridgeIndexVerifiedAt: new Date(),
					updatedAt: new Date(),
				},
			},
			writeOptions(),
		);
	assert.equal(
		bridgeIndexManifest.matchedCount,
		1,
		"Manifest changed while recording the verified bridge index.",
	);

	const useTransaction = await transactionSupported(db);
	const appliedPlans = useTransaction
		? await applyInTransaction({ db, manifest, backupRecords })
		: await applyWithoutTransaction({ db, manifest, backupRecords });
	await postverifyApplied({
		db,
		manifest,
		plans: appliedPlans,
		backupRecords,
	});
	return {
		ok: true,
		mode: "apply",
		action: "repair",
		writesPerformed: true,
		repairId,
		backupCollection: manifest.backupCollection,
		backupDocumentCount: 8,
		transactionUsed: useTransaction,
		crossTransportIndex: bridgeIndex,
		results: appliedResultRows(appliedPlans),
		postverify: {
			reservations: 2,
			unchangedInboundAudits: 6,
			backupHashesVerified: 8,
			excludedPmsConfirmation: EXCLUDED_PMS_CONFIRMATION,
		},
	};
};

const plansFromBackups = ({ backupRecords, manifest }) => {
	const reservationBackups = backupRecordsBySource(
		backupRecords,
		RESERVATION_COLLECTION,
	);
	const reservations = TARGETS.map(
		(target) => reservationBackups.get(target.mongoId)?.originalDocument,
	);
	const auditBackups = backupRecordsBySource(backupRecords, INBOUND_COLLECTION);
	const audits = ALL_AUDIT_IDS.map(
		(auditId) => auditBackups.get(auditId)?.originalDocument,
	);
	const plans = buildRepairPlans({
		reservations,
		audits,
		context: contextFromManifest(manifest),
	});
	assertPlansMatchBackups(plans, backupRecords);
	return plans;
};

const classifyRollbackState = ({ scope, plans }) => {
	const currentById = new Map(
		scope.reservations.map((reservation) => [id(reservation), reservation]),
	);
	return plans.map((plan) => {
		const current = currentById.get(plan.target.mongoId);
		const hash = canonicalEjsonSha256(current);
		let state = "changed_or_unknown";
		if (hash === plan.originalHash) state = "original";
		if (hash === plan.expectedHash) state = "repaired";
		return {
			plan,
			current,
			currentHash: hash,
			state,
		};
	});
};

const rollbackDryRunReport = ({ manifest, classifications }) => ({
	ok: true,
	mode: "dry-run",
	action: "rollback",
	writesPerformed: false,
	repairId: String(manifest._id),
	backupCollection: manifest.backupCollection,
	manifestState: manifest.state,
	safeToRollback: classifications.every((entry) =>
		["original", "repaired"].includes(entry.state),
	),
	results: classifications.map((entry) => ({
		pmsConfirmation: entry.plan.target.pmsConfirmation,
		reservationMongoId: entry.plan.target.mongoId,
		currentState: entry.state,
		currentHash: entry.currentHash,
		requiredRepairedHash: entry.plan.expectedHash,
		restoredHash: entry.plan.originalHash,
	})),
	nextStep:
		"Rollback writes require --rollback --apply --repair-id with the identical repair ID. Each replacement uses the complete expected repaired document as its CAS filter.",
});

const restorePlansInTransaction = async ({
	db,
	manifest,
	plans,
	allowedManifestStates,
}) => {
	const manifestCollection = db.collection(MANIFEST_COLLECTION);
	const session = await mongoose.startSession();
	try {
		await session.withTransaction(
			async () => {
				for (const plan of plans) {
					const current = await Reservations.collection.findOne(
						{ _id: objectId(plan.target.mongoId) },
						queryOptions(session),
					);
					const hash = canonicalEjsonSha256(current);
					if (hash === plan.originalHash) continue;
					assert.equal(hash, plan.expectedHash, `Rollback CAS precondition failed for PMS ${plan.target.pmsConfirmation}.`);
					await assertManifestFence({
						manifestCollection,
						repairId: String(manifest._id),
						state: manifest.state,
						session,
					});
					const result = await Reservations.collection.replaceOne(
						buildExactCasFilter(plan.expectedDocument),
						cloneBson(plan.originalDocument),
						{ session },
					);
					assert.equal(result.matchedCount, 1, `Rollback did not match PMS ${plan.target.pmsConfirmation}.`);
					assert.equal(result.modifiedCount, 1, `Rollback did not restore PMS ${plan.target.pmsConfirmation}.`);
				}
				await assertManifestFence({
					manifestCollection,
					repairId: String(manifest._id),
					state: manifest.state,
					session,
				});
				const manifestResult = await manifestCollection.updateOne(
					rollbackManifestClaimFilter(
						manifest,
						allowedManifestStates,
					),
					{
						$set: {
							state: "rolled_back",
							rolledBackAt: new Date(),
							rollbackTransactionUsed: true,
							updatedAt: new Date(),
						},
					},
					{ session },
				);
				assert.equal(manifestResult.matchedCount, 1, "Rollback manifest state changed concurrently.");
			},
			{
				readConcern: { level: "snapshot" },
				writeConcern: { w: "majority" },
				readPreference: "primary",
			},
		);
	} finally {
		await session.endSession();
	}
};

const rollForwardRepairedDocuments = async ({
	plans,
	beforeWrite = null,
}) => {
	for (const plan of plans) {
		const current = await Reservations.collection.findOne(
			{ _id: objectId(plan.target.mongoId) },
			queryOptions(),
		);
		const hash = canonicalEjsonSha256(current);
		if (hash === plan.expectedHash) continue;
		assert.equal(hash, plan.originalHash, `Cannot restore repaired state for PMS ${plan.target.pmsConfirmation}.`);
		if (beforeWrite) await beforeWrite();
		const result = await Reservations.collection.replaceOne(
			buildExactCasFilter(plan.originalDocument),
			cloneBson(plan.expectedDocument),
			writeOptions(),
		);
		assert.equal(result.matchedCount, 1, `Roll-forward did not match PMS ${plan.target.pmsConfirmation}.`);
		assert.equal(result.modifiedCount, 1, `Roll-forward did not restore PMS ${plan.target.pmsConfirmation}.`);
	}
};

const restorePlansWithoutTransaction = async ({
	db,
	manifest,
	plans,
	allowedManifestStates,
}) => {
	const context = contextFromManifest(manifest);
	const manifests = db.collection(MANIFEST_COLLECTION);
	const rollbackStartedAt = new Date();
	const rollbackOperationToken = crypto.randomUUID();
	const claim = await manifests.updateOne(
		rollbackManifestClaimFilter(manifest, allowedManifestStates),
		{
			$set: {
				state: "rolling_back",
				rollbackStartedAt,
				rollbackOperationToken,
				rollbackTransactionUsed: false,
				updatedAt: new Date(),
			},
		},
		writeOptions(),
	);
	assert.equal(
		claim.matchedCount,
		1,
		"Rollback manifest could not be exclusively claimed; another operator may be acting on it.",
	);
	const assertRollbackFence = () =>
		assertManifestFence({
			manifestCollection: manifests,
			repairId: context.repairId,
			state: "rolling_back",
			operationToken: rollbackOperationToken,
			tokenField: "rollbackOperationToken",
		});
	try {
		for (const plan of plans) {
			const current = await Reservations.collection.findOne(
				{ _id: objectId(plan.target.mongoId) },
				queryOptions(),
			);
			const hash = canonicalEjsonSha256(current);
			if (hash === plan.originalHash) continue;
			assert.equal(hash, plan.expectedHash, `Rollback CAS precondition failed for PMS ${plan.target.pmsConfirmation}.`);
			await assertRollbackFence();
			const result = await Reservations.collection.replaceOne(
				buildExactCasFilter(plan.expectedDocument),
				cloneBson(plan.originalDocument),
				writeOptions(),
			);
			assert.equal(result.matchedCount, 1, `Rollback did not match PMS ${plan.target.pmsConfirmation}.`);
			assert.equal(result.modifiedCount, 1, `Rollback did not restore PMS ${plan.target.pmsConfirmation}.`);
		}
		await assertRollbackFence();
		const result = await manifests.updateOne(
			{
				_id: context.repairId,
				state: "rolling_back",
				rollbackStartedAt,
				rollbackOperationToken,
			},
			{
				$set: {
					state: "rolled_back",
					rolledBackAt: new Date(),
					rollbackTransactionUsed: false,
					updatedAt: new Date(),
				},
			},
			writeOptions(),
		);
		assert.equal(result.matchedCount, 1, "Rollback manifest disappeared.");
	} catch (error) {
		let rollForwardError = null;
		try {
			// Inspect every target, not only acknowledged writes: this also
			// handles an update whose server result was lost after it committed.
			await rollForwardRepairedDocuments({
				plans,
				beforeWrite: assertRollbackFence,
			});
		} catch (restoreError) {
			rollForwardError = restoreError;
		}
		const failureState = await manifests.updateOne(
			{
				_id: context.repairId,
				state: { $in: ["rolling_back", "rolled_back"] },
				rollbackStartedAt,
				rollbackOperationToken,
			},
			{
				$set: {
					state: rollForwardError
						? "rollback_partial_manual_intervention"
						: "rollback_failed_restored",
					rollbackError: String(error?.message || error).slice(0, 1000),
					rollForwardError: rollForwardError
						? String(rollForwardError?.message || rollForwardError).slice(0, 1000)
						: "",
					updatedAt: new Date(),
				},
			},
			writeOptions(),
		);
		assert.equal(
			failureState.matchedCount,
			1,
			"Manifest changed while recording the failed rollback state.",
		);
		if (rollForwardError) {
			throw new Error(`Rollback failed and exact roll-forward was also blocked: ${error.message}; roll-forward: ${rollForwardError.message}`);
		}
		throw new Error(`Rollback failed; all conditionally restored documents were returned to their exact repaired state: ${error.message}`);
	}
};

const verifyRolledBack = async ({ db, manifest, plans, backupRecords }) => {
	const scope = await loadScope();
	const byId = new Map(scope.reservations.map((reservation) => [id(reservation), reservation]));
	for (const plan of plans) {
		assert.equal(canonicalEjsonSha256(byId.get(plan.target.mongoId)), plan.originalHash, `Rollback postverify failed for PMS ${plan.target.pmsConfirmation}.`);
	}
	const auditBackups = backupRecordsBySource(backupRecords, INBOUND_COLLECTION);
	for (const audit of scope.audits) {
		assert.equal(canonicalEjsonSha256(audit), auditBackups.get(id(audit)).originalHash, `Rollback postverify found changed audit ${id(audit)}.`);
	}
	await readBackupsForManifest({ db, manifest });
	const savedManifest = await db.collection(MANIFEST_COLLECTION).findOne(
		{ _id: String(manifest._id) },
		queryOptions(),
	);
	assert.equal(savedManifest?.state, "rolled_back", "Manifest is not rolled_back after rollback postverify.");
	return true;
};

const executeRollback = async ({ db, repairId, apply }) => {
	const manifest = validateManifest(
		await db
			.collection(MANIFEST_COLLECTION)
			.findOne({ _id: repairId }, queryOptions()),
		repairId,
	);
	const backupRecords = await readBackupsForManifest({ db, manifest });
	const plans = plansFromBackups({ backupRecords, manifest });
	const scope = await loadScope();
	const auditBackups = backupRecordsBySource(backupRecords, INBOUND_COLLECTION);
	for (const audit of scope.audits) {
		assert.equal(canonicalEjsonSha256(audit), auditBackups.get(id(audit)).originalHash, `Inbound audit ${id(audit)} changed; rollback is blocked.`);
	}
	const classifications = classifyRollbackState({ scope, plans });
	if (classifications.some((entry) => entry.state === "changed_or_unknown")) {
		throw new Error("Rollback is blocked because at least one reservation differs from both the exact original and exact repaired hashes.");
	}
	const allowedManifestStates = rollbackClaimStates(manifest);
	if (!apply) return rollbackDryRunReport({ manifest, classifications });

	const useTransaction = await transactionSupported(db);
	if (useTransaction) {
		await restorePlansInTransaction({
			db,
			manifest,
			plans,
			allowedManifestStates,
		});
	} else {
		await restorePlansWithoutTransaction({
			db,
			manifest,
			plans,
			allowedManifestStates,
		});
	}
	await verifyRolledBack({ db, manifest, plans, backupRecords });
	return {
		ok: true,
		mode: "apply",
		action: "rollback",
		writesPerformed: true,
		repairId,
		backupCollection: manifest.backupCollection,
		transactionUsed: useTransaction,
		results: plans.map((plan) => ({
			pmsConfirmation: plan.target.pmsConfirmation,
			reservationMongoId: plan.target.mongoId,
			restoredHash: plan.originalHash,
			postverified: true,
		})),
	};
};

const main = async (argv = process.argv.slice(2)) => {
	const args = parseCliArguments(argv);
	if (args.help) return { help: usage() };
	const database =
		process.env.DATABASE || process.env.MONGO_URI || process.env.MONGODB_URI;
	if (!database) throw new Error("Missing DATABASE/MONGO connection string.");
	await mongoose.connect(database, {
		autoIndex: false,
		autoCreate: false,
		readPreference: "primary",
	});
	const db = mongoose.connection.db;

	if (args.rollback) {
		return executeRollback({
			db,
			repairId: args.repairId,
			apply: args.apply,
		});
	}
	if (args.apply) return executeApply({ db, repairId: args.repairId });

	const scope = await loadScope();
	const now = new Date();
	const context = {
		repairId: args.repairId || "dryrun-preview-only",
		repairAt: now,
		backupCollection: "dry-run-not-created",
	};
	const plans = buildRepairPlans({
		reservations: scope.reservations,
		audits: scope.audits,
		context,
	});
	const bridgeIndex = await inspectCrossTransportIndex({
		targetClaimState: "none",
	});
	return {
		...buildDryRunReport({
		plans,
		audits: scope.audits,
		repairId: args.repairId,
		}),
		crossTransportIndex: bridgeIndex,
	};
};

const runCli = () =>
	main()
		.then((report) => {
			if (report?.help) process.stdout.write(`${report.help}\n`);
			else process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		})
		.catch((error) => {
			process.stderr.write(
				`${JSON.stringify(
					{
						ok: false,
						error: String(error?.message || error),
						safety: "No broad retry is permitted. Re-run dry-run and inspect the exact target/backup state.",
					},
					null,
					2,
				)}\n`,
			);
			process.exitCode = 1;
		})
		.finally(async () => {
			if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
		});

if (require.main === module) runCli();

module.exports = {
	CROSS_TRANSPORT_INDEX_KEY,
	CROSS_TRANSPORT_INDEX_NAME,
	CROSS_TRANSPORT_INDEX_PARTIAL,
	applyWithoutTransaction,
	classifyRollbackState,
	comparePlannedAndSavedBackups,
	contextFromManifest,
	ensureCrossTransportIndex,
	inspectCrossTransportIndex,
	loadScope,
	main,
	rollbackManifestClaimFilter,
	restoreOriginalDocuments,
	rollbackClaimStates,
	rollbackDryRunReport,
	runCli,
	updateOnePlan,
	usage,
	validateManifest,
};
