/**
 * Restore the confirmed/released workflow state of exactly one Agoda booking
 * that was incorrectly staged by a guest fee-waiver message.
 *
 * Dry run (default, no writes):
 *   node scripts/repairAgodaGuestMessageReview20260805.js
 *
 * Apply (the application must already be stopped):
 *   node scripts/repairAgodaGuestMessageReview20260805.js \
 *     --apply --maintenance-window --repair-id agoda-20260805-<change-id>
 *
 * Rollback dry run / apply:
 *   node scripts/repairAgodaGuestMessageReview20260805.js \
 *     --rollback --repair-id agoda-20260805-<change-id>
 *   node scripts/repairAgodaGuestMessageReview20260805.js \
 *     --rollback --apply --maintenance-window \
 *     --repair-id agoda-20260805-<change-id>
 *
 * No inbound audit is modified or deleted. A full reservation + four-audit
 * backup is retained permanently for verification and conditional rollback.
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
	MANIFEST_COLLECTION,
	OPERATION,
	TARGET,
	buildBackupCollectionName,
	buildRepairPlan,
	validateAuditSet,
	validateCurrentReservation,
	validateRepairId,
	verifyRepairedDocument,
} = require("../services/agodaGuestMessageReviewRepair20260805");
const {
	buildExactCasFilter,
	canonicalEjsonSha256,
	canonicalEqual,
	cloneBson,
} = require("../services/tripHotelRunnerRepair20260805");

const PRIMARY_MAJORITY_READ = Object.freeze({
	readPreference: "primary",
	readConcern: Object.freeze({ level: "majority" }),
});
const MAJORITY_WRITE = Object.freeze({ writeConcern: Object.freeze({ w: "majority" }) });
const RESERVATION_COLLECTION = "reservations";
const INBOUND_COLLECTION = "inboundemails";

const usage = () => [
	"Usage:",
	"  node scripts/repairAgodaGuestMessageReview20260805.js [--repair-id <id>]",
	"  node scripts/repairAgodaGuestMessageReview20260805.js --apply --maintenance-window --repair-id <id>",
	"  node scripts/repairAgodaGuestMessageReview20260805.js --rollback --repair-id <id>",
	"  node scripts/repairAgodaGuestMessageReview20260805.js --rollback --apply --maintenance-window --repair-id <id>",
	"",
	"Writes require --apply, --maintenance-window, and an explicit repair ID.",
	`Fixed scope: Agoda OTA ${TARGET.otaConfirmation} / PMS ${TARGET.pmsConfirmation} / Mongo ${TARGET.mongoId}.`,
].join("\n");

const parseArguments = (argv = []) => {
	const args = {
		apply: false,
		rollback: false,
		maintenanceWindow: false,
		repairId: "",
	};
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (token === "--apply") args.apply = true;
		else if (token === "--rollback") args.rollback = true;
		else if (token === "--maintenance-window") args.maintenanceWindow = true;
		else if (token === "--repair-id") {
			assert.ok(argv[index + 1], "--repair-id requires a value.");
			assert.equal(args.repairId, "", "--repair-id may be supplied only once.");
			args.repairId = validateRepairId(argv[index + 1]);
			index += 1;
		} else if (token === "--help" || token === "-h") {
			args.help = true;
		} else {
			throw new Error(`Unknown argument: ${token}`);
		}
	}
	if (args.apply) {
		assert.ok(args.repairId, "--apply requires --repair-id.");
		assert.equal(
			args.maintenanceWindow,
			true,
			"--apply requires --maintenance-window after the application is stopped.",
		);
	}
	if (args.rollback) {
		assert.ok(args.repairId, "--rollback requires --repair-id.");
	}
	if (!args.apply && args.maintenanceWindow) {
		throw new Error("--maintenance-window is meaningful only with --apply.");
	}
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

const readReservationAfterWrite = async ({
	reservationCollection,
	reservationId = TARGET.mongoId,
	maxAttempts = 3,
}) => {
	let lastError = null;
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			return await reservationCollection.findOne(
				{ _id: objectId(reservationId) },
				readOptions(),
			);
		} catch (error) {
			lastError = error;
		}
	}
	throw new Error(
		`Could not resolve reservation state after a database write in ${maxAttempts} primary/majority read attempts: ${lastError?.message || "unknown read error"}`,
	);
};

const executeWriteWithHashReadback = async ({
	reservationCollection,
	write,
	beforeHash,
	afterHash,
	validateAcknowledgement = () => {},
}) => {
	let acknowledgementError = null;
	try {
		const result = await write();
		validateAcknowledgement(result);
	} catch (error) {
		acknowledgementError = error;
	}

	const document = await readReservationAfterWrite({ reservationCollection });
	assert.ok(document, "Target reservation disappeared during the maintenance write.");
	const observedHash = canonicalEjsonSha256(document);
	if (observedHash === afterHash) {
		return {
			document,
			observedHash,
			state: "after",
			acknowledgementLost: !!acknowledgementError,
			acknowledgementError: acknowledgementError?.message || "",
		};
	}
	if (observedHash === beforeHash) {
		const error = new Error(
			acknowledgementError
				? `Maintenance write did not commit: ${acknowledgementError.message}`
				: "Maintenance write acknowledgement did not produce the expected document.",
		);
		error.writeResolution = "before";
		error.observedHash = observedHash;
		throw error;
	}
	const error = new Error(
		`Maintenance write outcome is ambiguous: observed hash ${observedHash} is neither the exact before nor exact after hash.`,
	);
	error.writeResolution = "unexpected";
	error.observedHash = observedHash;
	error.acknowledgementError = acknowledgementError?.message || "";
	throw error;
};

const scopeAuditQuery = () => ({
	$or: [
		{ reservationMongoId: objectId(TARGET.mongoId) },
		{
			provider: "agoda",
			confirmationNumber: TARGET.otaConfirmation,
		},
	],
});

const loadScope = async ({ reservationCollection, inboundCollection }) => {
	const reservation = await reservationCollection.findOne(
		{ _id: objectId(TARGET.mongoId) },
		readOptions(),
	);
	const audits = await inboundCollection
		.find(scopeAuditQuery(), readOptions())
		.sort({ receivedAt: 1, _id: 1 })
		.toArray();
	validateCurrentReservation(reservation);
	validateAuditSet(audits);
	assert.deepEqual(
		audits.map((audit) => String(audit._id)).sort(),
		[...ALL_AUDIT_IDS].sort(),
		"A newer, missing, or unrelated Agoda audit entered the repair scope; re-audit before proceeding.",
	);
	return { reservation, audits };
};

const auditHashes = (audits) =>
	Object.fromEntries(
		audits.map((audit) => [String(audit._id), canonicalEjsonSha256(audit)]),
	);

const assertAuditsUnchanged = (audits, expectedHashes) => {
	validateAuditSet(audits);
	assert.deepEqual(auditHashes(audits), expectedHashes, "Inbound audit evidence changed.");
	return true;
};

const buildBackupRecords = ({ plan, audits, context }) => {
	const shared = {
		repairId: context.repairId,
		operation: OPERATION,
		backupCollection: context.backupCollection,
		backupAt: new Date(context.backupAt),
		evidenceAuditIds: [...ALL_AUDIT_IDS],
	};
	return [
		{
			_id: `${RESERVATION_COLLECTION}:${TARGET.mongoId}`,
			...shared,
			sourceCollection: RESERVATION_COLLECTION,
			originalId: plan.originalDocument._id,
			originalHash: plan.originalHash,
			expectedRepairedHash: plan.expectedHash,
			originalDocument: cloneBson(plan.originalDocument),
		},
		...audits.map((audit) => ({
			_id: `${INBOUND_COLLECTION}:${audit._id}`,
			...shared,
			sourceCollection: INBOUND_COLLECTION,
			originalId: audit._id,
			originalHash: canonicalEjsonSha256(audit),
			expectedRepairedHash: canonicalEjsonSha256(audit),
			originalDocument: cloneBson(audit),
		})),
	];
};

const verifyBackupRecords = ({ records, context }) => {
	assert.ok(Array.isArray(records), "Backup readback must be an array.");
	assert.equal(records.length, 5, "Backup must contain one reservation and four audits.");
	const seen = new Set();
	for (const record of records) {
		assert.equal(String(record.repairId || ""), context.repairId);
		assert.equal(String(record.operation || ""), OPERATION);
		assert.equal(String(record.backupCollection || ""), context.backupCollection);
		assert.ok(
			[RESERVATION_COLLECTION, INBOUND_COLLECTION].includes(record.sourceCollection),
			"Unexpected backup source collection.",
		);
		assert.equal(seen.has(String(record._id)), false, "Duplicate backup record.");
		seen.add(String(record._id));
		assert.equal(
			String(record.originalDocument?._id || ""),
			String(record.originalId || ""),
			"Backup embedded document ID changed.",
		);
		assert.equal(
			canonicalEjsonSha256(record.originalDocument),
			record.originalHash,
			"Backup canonical hash mismatch.",
		);
	}
	assert.equal(
		records.filter((record) => record.sourceCollection === RESERVATION_COLLECTION).length,
		1,
	);
	assert.equal(
		records.filter((record) => record.sourceCollection === INBOUND_COLLECTION).length,
		4,
	);
	assert.deepEqual(
		[...seen].sort(),
		[
			`${RESERVATION_COLLECTION}:${TARGET.mongoId}`,
			...ALL_AUDIT_IDS.map((auditId) => `${INBOUND_COLLECTION}:${auditId}`),
		].sort(),
		"Backup contains a document outside the exact fixed repair scope.",
	);
	return true;
};

const assertManifestFence = async ({
	manifestCollection,
	repairId,
	state,
	token,
	tokenField,
}) => {
	const manifest = await manifestCollection.findOne(
		{ _id: repairId, state, [tokenField]: token },
		readOptions({ projection: { _id: 1 } }),
	);
	assert.ok(manifest, `Manifest ownership fence was lost in state ${state}.`);
	return true;
};

const writeManifestTransition = async ({
	manifestCollection,
	repairId,
	fromState,
	toState,
	token,
	tokenField,
	set = {},
}) => {
	const result = await manifestCollection.updateOne(
		{ _id: repairId, state: fromState, [tokenField]: token },
		{
			$set: {
				state: toState,
				updatedAt: new Date(),
				...set,
			},
		},
		writeOptions(),
	);
	assert.equal(result.matchedCount, 1, `Manifest transition ${fromState}->${toState} lost ownership.`);
	assert.equal(result.modifiedCount, 1, `Manifest transition ${fromState}->${toState} was not written.`);
};

const claimNewRepair = async ({ manifestCollection, context, plan }) => {
	const token = crypto.randomBytes(24).toString("hex");
	try {
		await manifestCollection.insertOne(
			{
				_id: context.repairId,
				operation: OPERATION,
				state: "initializing",
				applyToken: token,
				backupCollection: context.backupCollection,
				originalHash: plan.originalHash,
				expectedRepairedHash: plan.expectedHash,
				auditHashes: plan.auditHashes,
				target: cloneBson(TARGET),
				createdAt: new Date(context.repairAt),
				updatedAt: new Date(context.repairAt),
			},
			writeOptions(),
		);
	} catch (error) {
		if (error?.code === 11000) {
			const existing = await manifestCollection.findOne(
				{ _id: context.repairId },
				readOptions({ projection: { state: 1, backupCollection: 1 } }),
			);
			throw new Error(
				`Repair ID already exists in state ${existing?.state || "unknown"}; repair IDs are never taken over or reused.`,
			);
		}
		throw error;
	}
	return token;
};

const createAndVerifyBackup = async ({ db, records, context }) => {
	const existing = await db
		.listCollections({ name: context.backupCollection }, { nameOnly: true })
		.toArray();
	assert.equal(existing.length, 0, "Backup collection already exists; no write is allowed.");
	await db.createCollection(context.backupCollection, writeOptions());
	const collection = db.collection(context.backupCollection);
	const inserted = await collection.insertMany(records, {
		ordered: true,
		...writeOptions(),
	});
	assert.equal(inserted.insertedCount, 5, "Exactly five backup documents must be inserted.");
	const readback = await collection.find({}, readOptions()).sort({ _id: 1 }).toArray();
	verifyBackupRecords({ records: readback, context });
	return readback;
};

const dryRunReport = ({ plan, context }) => ({
	ok: true,
	mode: "dry-run",
	writesPerformed: false,
	repairId: context.repairId || null,
	scope: {
		reservationMongoId: TARGET.mongoId,
		pmsConfirmation: TARGET.pmsConfirmation,
		otaConfirmation: TARGET.otaConfirmation,
		inboundAuditIds: [...ALL_AUDIT_IDS],
	},
	evidence: {
		originalHash: plan.originalHash,
		casFilterHash: plan.casFilterHash,
		expectedRepairedHash: plan.expectedHash,
		auditHashes: plan.auditHashes,
	},
	changes: [
		"state/reservation_status: ota platform review -> confirmed",
		"otaPlatformReview.status: pending -> released",
		"restore the original Agoda confirmation as the review/actionable inbound link",
		"remove only the offending proposedInbound staging payload",
		"restore release-time admin pricing visibility metadata",
		"append a permanent repair audit entry",
	],
	preserved: [
		"PMS and OTA confirmation identities",
		"hotel, Triple room mapping, Aug 14-17 stay",
		"SAR 226.38 guest total, SAR 225 hotel base, SAR 140.07 Agoda payout",
		"release/admin confirmation evidence and all financial fields",
		"all four original inbound audit documents, including the misclassified message",
	],
	nextStep:
		"Stop hotels-backend, rerun this dry run, then apply with --apply --maintenance-window and a unique --repair-id.",
});

const compensateApply = async ({
	reservationCollection,
	manifestCollection,
	context,
	plan,
	token,
}) => {
	const current = await reservationCollection.findOne(
		{ _id: objectId(TARGET.mongoId) },
		readOptions(),
	);
	if (!current || canonicalEjsonSha256(current) !== plan.expectedHash) return false;
	await assertManifestFence({
		manifestCollection,
		repairId: context.repairId,
		state: "applying",
		token,
		tokenField: "applyToken",
	});
	const restored = await reservationCollection.replaceOne(
		buildExactCasFilter(current),
		cloneBson(plan.originalDocument),
		writeOptions(),
	);
	assert.equal(restored.modifiedCount, 1, "Conditional apply compensation failed.");
	const verify = await reservationCollection.findOne(
		{ _id: objectId(TARGET.mongoId) },
		readOptions(),
	);
	assert.equal(canonicalEjsonSha256(verify), plan.originalHash, "Compensation readback mismatch.");
	await writeManifestTransition({
		manifestCollection,
		repairId: context.repairId,
		fromState: "applying",
		toState: "compensated",
		token,
		tokenField: "applyToken",
		set: { compensatedAt: new Date() },
	});
	return true;
};

const applyRepair = async ({ db, collections, plan, audits, context }) => {
	const { reservationCollection, inboundCollection, manifestCollection } = collections;
	const token = await claimNewRepair({ manifestCollection, context, plan });
	const backupRecords = buildBackupRecords({ plan, audits, context });
	try {
		await assertManifestFence({
			manifestCollection,
			repairId: context.repairId,
			state: "initializing",
			token,
			tokenField: "applyToken",
		});
		await createAndVerifyBackup({ db, records: backupRecords, context });
		await writeManifestTransition({
			manifestCollection,
			repairId: context.repairId,
			fromState: "initializing",
			toState: "backed_up",
			token,
			tokenField: "applyToken",
			set: { backedUpAt: new Date(context.backupAt) },
		});

		const fresh = await loadScope({ reservationCollection, inboundCollection });
		assert.equal(canonicalEjsonSha256(fresh.reservation), plan.originalHash, "Reservation changed after planning.");
		assertAuditsUnchanged(fresh.audits, plan.auditHashes);
		await writeManifestTransition({
			manifestCollection,
			repairId: context.repairId,
			fromState: "backed_up",
			toState: "applying",
			token,
			tokenField: "applyToken",
			set: { applyingAt: new Date() },
		});
		await assertManifestFence({
			manifestCollection,
			repairId: context.repairId,
			state: "applying",
			token,
			tokenField: "applyToken",
		});
		const writeResolution = await executeWriteWithHashReadback({
			reservationCollection,
			write: () =>
				reservationCollection.updateOne(
					plan.casFilter,
					plan.update,
					writeOptions(),
				),
			beforeHash: plan.originalHash,
			afterHash: plan.expectedHash,
			validateAcknowledgement: (updated) => {
				assert.equal(
					updated.matchedCount,
					1,
					"Full-document CAS did not match; no repair was applied.",
				);
				assert.equal(
					updated.modifiedCount,
					1,
					"The target reservation was not modified exactly once.",
				);
			},
		});
		const after = writeResolution.document;
		verifyRepairedDocument({ before: plan.originalDocument, after, context });
		assert.equal(canonicalEjsonSha256(after), plan.expectedHash, "Repaired canonical hash mismatch.");
		const finalAudits = await inboundCollection
			.find(scopeAuditQuery(), readOptions())
			.sort({ receivedAt: 1, _id: 1 })
			.toArray();
		assertAuditsUnchanged(finalAudits, plan.auditHashes);
		await writeManifestTransition({
			manifestCollection,
			repairId: context.repairId,
			fromState: "applying",
			toState: "applied",
			token,
			tokenField: "applyToken",
			set: { appliedAt: new Date(), verifiedHash: plan.expectedHash },
		});
		return {
			ok: true,
			mode: "apply",
			writesPerformed: true,
			repairId: context.repairId,
			backupCollection: context.backupCollection,
			reservationMongoId: TARGET.mongoId,
			pmsConfirmation: TARGET.pmsConfirmation,
			otaConfirmation: TARGET.otaConfirmation,
			originalHash: plan.originalHash,
			repairedHash: plan.expectedHash,
			writeAcknowledgementRecovered:
				writeResolution.acknowledgementLost === true,
			inboundAuditsModified: false,
		};
	} catch (error) {
		let observed = null;
		let observationError = null;
		try {
			observed = await readReservationAfterWrite({ reservationCollection });
		} catch (caughtObservationError) {
			observationError = caughtObservationError;
		}
		if (observed && canonicalEjsonSha256(observed) === plan.expectedHash) {
			const manifest = await manifestCollection.findOne(
				{ _id: context.repairId },
				readOptions({
					projection: {
						state: 1,
						applyToken: 1,
						verifiedHash: 1,
					},
				}),
			);
			if (
				manifest?.state === "applied" &&
				manifest?.applyToken === token &&
				manifest?.verifiedHash === plan.expectedHash
			) {
				return {
					ok: true,
					mode: "apply",
					writesPerformed: true,
					repairId: context.repairId,
					backupCollection: context.backupCollection,
					reservationMongoId: TARGET.mongoId,
					pmsConfirmation: TARGET.pmsConfirmation,
					otaConfirmation: TARGET.otaConfirmation,
					originalHash: plan.originalHash,
					repairedHash: plan.expectedHash,
					writeAcknowledgementRecovered: true,
					manifestAcknowledgementRecovered: true,
					inboundAuditsModified: false,
				};
			}
			let compensated = false;
			let compensationError = null;
			try {
				compensated = await compensateApply({
					reservationCollection,
					manifestCollection,
					context,
					plan,
					token,
				});
			} catch (caughtCompensationError) {
				compensationError = caughtCompensationError;
			}
			if (compensated) {
				throw new Error(
					`Apply failed after the reservation write, but the exact original document was conditionally restored and verified. Manifest: ${context.repairId}. Cause: ${error.message}`,
				);
			}
			throw new Error(
				`Apply failed with the exact repaired document present, and conditional compensation failed or was unsafe. Inspect manifest ${context.repairId}. Apply error: ${error.message}. Compensation error: ${compensationError?.message || "manifest state was no longer applying"}`,
			);
		}
		if (observed && canonicalEjsonSha256(observed) === plan.originalHash) {
			const manifest = await manifestCollection.findOne(
				{ _id: context.repairId },
				readOptions({ projection: { state: 1, applyToken: 1 } }),
			);
			if (
				manifest?.applyToken === token &&
				["initializing", "backed_up", "applying"].includes(manifest.state)
			) {
				await writeManifestTransition({
					manifestCollection,
					repairId: context.repairId,
					fromState: manifest.state,
					toState: "failed_no_change",
					token,
					tokenField: "applyToken",
					set: {
						failedAt: new Date(),
						failure: error.message,
						verifiedOriginalHash: plan.originalHash,
					},
				});
			}
			throw new Error(
				`Apply failed with the exact original reservation verified unchanged. Manifest ${context.repairId} is not reusable. Cause: ${error.message}`,
			);
		}
		throw new Error(
			`Apply outcome could not be resolved safely; no further write was attempted. Inspect manifest ${context.repairId}. Cause: ${error.message}. Observation: ${observationError?.message || "reservation hash was neither exact original nor exact repaired"}`,
		);
	}
};

const loadManifestAndBackup = async ({ db, repairId }) => {
	const manifestCollection = db.collection(MANIFEST_COLLECTION);
	const manifest = await manifestCollection.findOne({ _id: repairId }, readOptions());
	assert.ok(manifest, `Repair manifest ${repairId} was not found.`);
	assert.equal(manifest.operation, OPERATION, "Manifest operation mismatch.");
	assert.equal(manifest.state, "applied", "Only an applied repair may be rolled back.");
	const backupCollection = db.collection(manifest.backupCollection);
	const records = await backupCollection.find({}, readOptions()).sort({ _id: 1 }).toArray();
	const context = {
		repairId,
		backupCollection: manifest.backupCollection,
		backupAt: records[0]?.backupAt,
		repairAt: manifest.createdAt,
	};
	verifyBackupRecords({ records, context });
	return { manifestCollection, manifest, records, context };
};

const rollbackRepair = async ({ db, collections, args }) => {
	const loaded = await loadManifestAndBackup({ db, repairId: args.repairId });
	const reservationRecord = loaded.records.find(
		(record) => record.sourceCollection === RESERVATION_COLLECTION,
	);
	const auditRecords = loaded.records.filter(
		(record) => record.sourceCollection === INBOUND_COLLECTION,
	);
	const current = await collections.reservationCollection.findOne(
		{ _id: objectId(TARGET.mongoId) },
		readOptions(),
	);
	assert.equal(
		canonicalEjsonSha256(current),
		loaded.manifest.expectedRepairedHash,
		"Current reservation no longer equals the exact repaired document; rollback is unsafe.",
	);
	const currentAudits = await collections.inboundCollection
		.find(scopeAuditQuery(), readOptions())
		.sort({ receivedAt: 1, _id: 1 })
		.toArray();
	const backedUpAuditHashes = Object.fromEntries(
		auditRecords.map((record) => [String(record.originalId), record.originalHash]),
	);
	assert.equal(
		reservationRecord.originalHash,
		loaded.manifest.originalHash,
		"Reservation backup hash does not match the independently stored manifest hash.",
	);
	assert.equal(
		reservationRecord.expectedRepairedHash,
		loaded.manifest.expectedRepairedHash,
		"Expected repaired hash differs between backup and manifest.",
	);
	assert.ok(
		canonicalEqual(backedUpAuditHashes, loaded.manifest.auditHashes),
		"Audit backup hashes do not match the independently stored manifest hashes.",
	);
	assertAuditsUnchanged(currentAudits, backedUpAuditHashes);
	if (!args.apply) {
		return {
			ok: true,
			mode: "rollback-dry-run",
			writesPerformed: false,
			repairId: args.repairId,
			currentRepairedHash: loaded.manifest.expectedRepairedHash,
			originalHash: reservationRecord.originalHash,
			backupCollection: loaded.manifest.backupCollection,
		};
	}

	const token = crypto.randomBytes(24).toString("hex");
	const claim = await loaded.manifestCollection.updateOne(
		{ _id: args.repairId, state: "applied" },
		{
			$set: {
				state: "rolling_back",
				rollbackToken: token,
				rollingBackAt: new Date(),
				updatedAt: new Date(),
			},
		},
		writeOptions(),
	);
	assert.equal(claim.modifiedCount, 1, "Rollback ownership could not be claimed.");
	await assertManifestFence({
		manifestCollection: loaded.manifestCollection,
		repairId: args.repairId,
		state: "rolling_back",
		token,
		tokenField: "rollbackToken",
	});
	try {
		const rollbackResolution = await executeWriteWithHashReadback({
			reservationCollection: collections.reservationCollection,
			write: () =>
				collections.reservationCollection.replaceOne(
					buildExactCasFilter(current),
					cloneBson(reservationRecord.originalDocument),
					writeOptions(),
				),
			beforeHash: loaded.manifest.expectedRepairedHash,
			afterHash: reservationRecord.originalHash,
			validateAcknowledgement: (replaced) => {
				assert.equal(
					replaced.modifiedCount,
					1,
					"Conditional rollback did not restore the reservation.",
				);
			},
		});
		const after = rollbackResolution.document;
		assert.equal(canonicalEjsonSha256(after), reservationRecord.originalHash, "Rollback hash mismatch.");
		validateCurrentReservation(after);
		const finalAudits = await collections.inboundCollection
			.find(scopeAuditQuery(), readOptions())
			.sort({ receivedAt: 1, _id: 1 })
			.toArray();
		assertAuditsUnchanged(finalAudits, backedUpAuditHashes);
		await writeManifestTransition({
			manifestCollection: loaded.manifestCollection,
			repairId: args.repairId,
			fromState: "rolling_back",
			toState: "rolled_back",
			token,
			tokenField: "rollbackToken",
			set: { rolledBackAt: new Date(), verifiedOriginalHash: reservationRecord.originalHash },
		});
		return {
			ok: true,
			mode: "rollback",
			writesPerformed: true,
			repairId: args.repairId,
			restoredHash: reservationRecord.originalHash,
			writeAcknowledgementRecovered:
				rollbackResolution.acknowledgementLost === true,
			inboundAuditsModified: false,
		};
	} catch (error) {
		let observed = null;
		let observationError = null;
		try {
			observed = await readReservationAfterWrite({
				reservationCollection: collections.reservationCollection,
			});
		} catch (caughtObservationError) {
			observationError = caughtObservationError;
		}
		const observedHash = observed ? canonicalEjsonSha256(observed) : "";
		const latestManifest = await loaded.manifestCollection.findOne(
			{ _id: args.repairId },
			readOptions({
				projection: {
					state: 1,
					rollbackToken: 1,
					verifiedOriginalHash: 1,
				},
			}),
		);
		if (
			observedHash === reservationRecord.originalHash &&
			latestManifest?.state === "rolled_back" &&
			latestManifest?.rollbackToken === token &&
			latestManifest?.verifiedOriginalHash === reservationRecord.originalHash
		) {
			return {
				ok: true,
				mode: "rollback",
				writesPerformed: true,
				repairId: args.repairId,
				restoredHash: reservationRecord.originalHash,
				writeAcknowledgementRecovered: true,
				manifestAcknowledgementRecovered: true,
				inboundAuditsModified: false,
			};
		}
		if (observedHash === loaded.manifest.expectedRepairedHash) {
			if (
				latestManifest?.state === "rolling_back" &&
				latestManifest?.rollbackToken === token
			) {
				await writeManifestTransition({
					manifestCollection: loaded.manifestCollection,
					repairId: args.repairId,
					fromState: "rolling_back",
					toState: "applied",
					token,
					tokenField: "rollbackToken",
					set: {
						rollbackFailedNoChangeAt: new Date(),
						rollbackError: error.message,
					},
				});
			}
			throw new Error(
				`Rollback failed with the exact repaired reservation verified unchanged; manifest was returned to applied. Cause: ${error.message}`,
			);
		}
		if (observedHash !== reservationRecord.originalHash) {
			throw new Error(
				`Rollback outcome could not be resolved safely; no compensation was attempted. Inspect manifest ${args.repairId}. Cause: ${error.message}. Observation: ${observationError?.message || "reservation hash was neither exact repaired nor exact original"}`,
			);
		}
		let rollForwardError = null;
		try {
			await assertManifestFence({
				manifestCollection: loaded.manifestCollection,
				repairId: args.repairId,
				state: "rolling_back",
				token,
				tokenField: "rollbackToken",
			});
			const restoredRepair = await collections.reservationCollection.replaceOne(
				buildExactCasFilter(observed),
				cloneBson(current),
				writeOptions(),
			);
			assert.equal(restoredRepair.modifiedCount, 1, "Conditional rollback compensation failed.");
			const compensated = await collections.reservationCollection.findOne(
				{ _id: objectId(TARGET.mongoId) },
				readOptions(),
			);
			assert.equal(
				canonicalEjsonSha256(compensated),
				loaded.manifest.expectedRepairedHash,
				"Rollback compensation readback mismatch.",
			);
			await writeManifestTransition({
				manifestCollection: loaded.manifestCollection,
				repairId: args.repairId,
				fromState: "rolling_back",
				toState: "applied",
				token,
				tokenField: "rollbackToken",
				set: {
					rollbackCompensatedAt: new Date(),
					rollbackError: error.message,
				},
			});
		} catch (caughtRollForwardError) {
			rollForwardError = caughtRollForwardError;
		}
		if (!rollForwardError) {
			throw new Error(
				`Rollback failed after its write, but the exact repaired document was conditionally restored and verified. Manifest returned to applied. Cause: ${error.message}`,
			);
		}
		throw new Error(
			`Rollback failed after its write and conditional roll-forward also failed or was unsafe. Inspect manifest ${args.repairId}. Rollback error: ${error.message}. Compensation error: ${rollForwardError.message}`,
		);
	}
};

const main = async () => {
	const args = parseArguments(process.argv.slice(2));
	if (args.help) {
		console.log(usage());
		return;
	}
	const database =
		process.env.DATABASE || process.env.MONGO_URI || process.env.MONGODB_URI;
	assert.ok(database, "Missing DATABASE/MONGO connection string.");
	await mongoose.connect(database, { autoIndex: false });
	const db = mongoose.connection.db;
	const collections = {
		reservationCollection: Reservations.collection,
		inboundCollection: InboundEmail.collection,
		manifestCollection: db.collection(MANIFEST_COLLECTION),
	};
	if (args.rollback) {
		console.log(JSON.stringify(await rollbackRepair({ db, collections, args }), null, 2));
		return;
	}

	const now = new Date();
	const previewRepairId = args.repairId || "dry-run-preview";
	const context = {
		repairId: previewRepairId,
		backupCollection: buildBackupCollectionName(previewRepairId),
		repairAt: now,
		backupAt: now,
	};
	const scope = await loadScope(collections);
	const plan = buildRepairPlan({
		reservation: scope.reservation,
		audits: scope.audits,
		context,
	});
	if (!args.apply) {
		console.log(JSON.stringify(dryRunReport({ plan, context: { ...context, repairId: args.repairId } }), null, 2));
		return;
	}
	console.log(
		JSON.stringify(
			await applyRepair({ db, collections, plan, audits: scope.audits, context }),
			null,
			2,
		),
	);
};

if (require.main === module) {
	main()
		.catch((error) => {
			console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
			process.exitCode = 1;
		})
		.finally(async () => {
			if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
		});
}

module.exports = {
	applyRepair,
	buildBackupRecords,
	executeWriteWithHashReadback,
	loadScope,
	parseArguments,
	readReservationAfterWrite,
	rollbackRepair,
	verifyBackupRecords,
};
