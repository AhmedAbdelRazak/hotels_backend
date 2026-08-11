/** @format */

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const mongoose = require("mongoose");
const {
	BACKUP_COLLECTION,
	FAILURE_CODE,
	FAILURE_REASON,
	REPAIR_ID,
	SCOPE_ATTESTATION,
	TARGETS,
	WORKER_UNIT,
	applyRecovery,
	applyUpdateToDocument,
	assertStandaloneWritablePrimary,
	buildPlan,
	ensureBackups,
	loadScopes,
	main,
	parseArguments,
	parseProof,
	proofToken,
} = require("./recoverHotelRunnerHalfCentProjection20260811");
const {
	canonicalEjsonSha256,
} = require("../services/tripHotelRunnerRepair20260805");

const PLAN_AT = new Date("2026-08-11T17:00:00.000Z");
const APPLY_AT = new Date("2026-08-11T17:01:00.000Z");
const RELEASE_SHA = "a".repeat(40);
const hash = (character) => character.repeat(64);
const oid = (value) => new mongoose.Types.ObjectId(value);
const id = (value) => String(value?._id || value || "").toLowerCase();
const releaseAttestation = (releaseSha = RELEASE_SHA) => ({
	releaseSha,
	treeSha: "b".repeat(40),
	capturedAt: APPLY_AT,
});

function targetFixture(target, index) {
	const receivedAt = new Date(`2026-08-11T${index ? "16:47" : "07:32"}:49.000Z`);
	const event = {
		_id: oid(target.eventId),
		__v: 0,
		hotelId: oid(target.hotelId),
		eventKey: hash(index ? "1" : "2"),
		messageUid: `half-cent-message-${index}`,
		payloadHash: hash(index ? "3" : "4"),
		canonicalHash: hash(index ? "5" : "6"),
		source: "push",
		hotelRunnerReservationId: target.hotelRunnerReservationId,
		hrNumber: target.hrNumber,
		providerNumber: target.confirmationNumber,
		channel: target.channel,
		state: "confirmed",
		modified: false,
		sourceUpdatedAt: receivedAt,
		payload: { exactStoredPayload: target.confirmationNumber },
		status: "quarantined",
		attempts: 1,
		nextAttemptAt: receivedAt,
		finalRecoveryAttempted: false,
		finalRecoveryClaimedAt: null,
		integrityReason: "",
		integrityConflict: false,
		integrityConflictCount: 0,
		errorCode: FAILURE_CODE,
		errorMessage: "",
		reservationMongoId: null,
		mirrorId: oid(target.mirrorId),
		result: {
			status: "quarantined",
			code: FAILURE_CODE,
			changedPaths: [],
			missingInvCodes: [],
			staleInvCodes: [],
		},
		deliveryCount: 1,
		lastReceivedAt: receivedAt,
		receivedAt,
		processedAt: new Date(receivedAt.getTime() + 5_000),
		createdAt: receivedAt,
		updatedAt: new Date(receivedAt.getTime() + 5_000),
	};
	const mirror = {
		_id: oid(target.mirrorId),
		__v: 0,
		hotelId: oid(target.hotelId),
		hrIdFingerprint: hash(index ? "7" : "8"),
		hotelRunnerReservationId: target.hotelRunnerReservationId,
		hrNumber: target.hrNumber,
		providerNumber: target.confirmationNumber,
		hrNumberAliases: [target.hrNumber],
		providerNumberAliases: [target.confirmationNumber],
		channel: target.channel,
		state: "confirmed",
		observedSourceUpdatedAt: receivedAt,
		observedCanonicalHash: event.canonicalHash,
		appliedSourceUpdatedAt: null,
		appliedCanonicalHash: "",
		lastMessageUid: event.messageUid,
		reservationMongoId: oid(target.preallocatedReservationId),
		linkMethod: "preallocated_create",
		linkedAt: null,
		linkEvidence: { planned: true },
		identityConflict: false,
		projectionStatus: "quarantined",
		projectionVersion: 0,
		normalizedSnapshot: {
			hotelRunnerReservationId: target.hotelRunnerReservationId,
			hrNumber: target.hrNumber,
			providerNumber: target.confirmationNumber,
			channel: target.channel,
			currency: "USD",
			state: "confirmed",
			checkinDate: target.checkinDate,
			checkoutDate: target.checkoutDate,
			totalCents: 2744,
			itemTotalCents: 2744,
			subTotalCents: 2744,
			totalRooms: 1,
			rooms: [
				{
					invCode: target.invCode,
					checkinDate: target.checkinDate,
					checkoutDate: target.checkoutDate,
					totalCents: 2744,
				},
			],
		},
		lastAppliedProjection: {},
		lastResult: {
			status: "quarantined",
			code: FAILURE_CODE,
			bridgeReason: FAILURE_REASON,
		},
		lastErrorCode: FAILURE_CODE,
		lastErrorMessage: FAILURE_CODE,
		createdAt: receivedAt,
		updatedAt: new Date(receivedAt.getTime() + 5_000),
	};
	const emailHash = hash(index ? "9" : "a");
	const job = {
		_id: oid(target.jobId),
		__v: 0,
		hotelId: oid(target.hotelId),
		provider: "trip",
		lookupConfirmationNumber: target.confirmationNumber,
		lookupConfirmationHash: hash(index ? "b" : "c"),
		confirmationNumber: target.confirmationNumber,
		identityKey: target.identityKey,
		hrIdFingerprint: hash(index ? "d" : "e"),
		inboundEmailId: oid(target.auditId),
		inboundEmailHash: emailHash,
		normalizedReservationHash: hash(index ? "f" : "1"),
		resolvedHotelProofHash: hash(index ? "2" : "3"),
		archiveFingerprint: hash(index ? "4" : "5"),
		status: "needs_review",
		notBefore: new Date(receivedAt.getTime() + 180_000),
		nextAttemptAt: new Date(receivedAt.getTime() + 180_000),
		attemptCount: 1,
		lookupAttemptCount: 0,
		seenCount: 1,
		lastSeenAt: receivedAt,
		lastDecision: "hotelrunner_local_state_needs_review",
		lastErrorCode: "HOTELRUNNER_LOCAL_RECORD_BLOCKED",
		lastErrorMessage:
			"HotelRunner evidence exists but cannot be selected safely; email fallback was not allowed.",
		lastLookup: { status: "", checkedAt: null, responseHash: "", resultCount: null, code: "" },
		negativeLookupProof: {},
		ingressDecision: {
			status: "api_observed",
			apiObservationKey: hash(index ? "6" : "7"),
			apiPayloadHash: event.payloadHash,
			apiObservedAt: receivedAt,
			apiLastObservedAt: receivedAt,
			apiObservationCount: 1,
		},
		hotelRunnerEventId: null,
		hotelRunnerMirrorId: null,
		reservationMongoId: null,
		inboundAuditFinalizationStatus: "completed",
		inboundAuditFinalizedAt: new Date(receivedAt.getTime() + 180_000),
		notificationOutboxStatus: "",
		notificationOutboxId: null,
		notificationOutboxEnqueuedAt: null,
		identityConflict: false,
		result: { terminalEvidence: true },
		completedAt: new Date(receivedAt.getTime() + 180_000),
		createdAt: receivedAt,
		updatedAt: new Date(receivedAt.getTime() + 180_000),
	};
	const audit = {
		_id: oid(target.auditId),
		__v: 0,
		hotelId: oid(target.hotelId),
		provider: "trip",
		confirmationNumber: target.confirmationNumber,
		intent: "new_reservation",
		eventType: "new",
		emailHash,
		senderAuthentication: {
			authenticatedAligned: true,
			trustedProvider: "trip",
		},
		processingStatus: "needs_review",
		automationAction: "skipped",
		skipReason: "hotelrunner_local_record_blocked",
		automationComment: job.lastErrorMessage,
		hasReservationConnection: false,
		reservationMongoId: null,
		matchedReservationBy: [],
		reconcileWarnings: [],
		reconcileErrors: [job.lastErrorMessage],
		hotelRunnerFirstFallback: {
			status: "needs_review",
			jobId: target.jobId,
			finalizedAt: job.completedAt,
			lastErrorCode: job.lastErrorCode,
			lastErrorMessage: job.lastErrorMessage,
		},
		reconciliation: {
			status: "needs_review",
			hotelRunnerFirstFallback: {
				status: "needs_review",
				decision: job.lastDecision,
				jobId: target.jobId,
			},
		},
		normalizedReservation: {
			provider: "trip",
			trustedTransportProvider: "trip",
			confirmationNumber: target.confirmationNumber,
			reservationId: target.confirmationNumber,
			intent: "new_reservation",
			eventType: "new",
			inboundEmailId: target.auditId,
			sourceSenderAuthenticated: true,
			sourceSenderTrusted: true,
			sourceAmount: target.sourceGross,
			sourceCurrency: "USD",
			propertyCurrency: "SAR",
			propertyConversionVerified: true,
			totalAmountSar: target.legacyPropertyGross,
			amount: target.legacyPropertyGross,
			totalPayoutSar: target.propertyPayout,
			netAfterExpensesTotal: target.propertyPayout,
			sourcePayoutAmount: target.sourcePayout,
			sourcePayoutCurrency: "USD",
			exchangeRateToSar: target.exchangeRate,
			exchangeRateSource: "exchange_rate_api_stored",
			sourceExchangeRateToSar: target.exchangeRate,
			sourceExchangeRateSource: "exchange_rate_api_stored",
			currencyConversionEvidence: {
				trusted: true,
				verified: true,
				sourceCurrency: "USD",
				propertyCurrency: "SAR",
				rate: target.exchangeRate,
				provenance: {
					provider: "exchange_rate_api",
					sourceType: "live_exchange_rate_api",
					sourceHash: hash(index ? "8" : "9"),
					sourceTimestamp: receivedAt,
				},
			},
			paymentSummary: {
				sourceCurrency: "USD",
				sourceTotalGuestPaymentAmount: target.sourceGross,
				sourceTotalPayoutAmount: target.sourcePayout,
				sourceTotalPayoutCurrency: "USD",
				totalGuestPaymentAmount: target.legacyPropertyGross,
				totalPayoutAmount: target.propertyPayout,
				currency: "SAR",
				exchangeRateToSar: target.exchangeRate,
			},
		},
		createdAt: receivedAt,
		updatedAt: job.updatedAt,
	};
	return { target, event, mirror, job, audit };
}

function getDotted(document, dotted) {
	return String(dotted)
		.split(".")
		.reduce((value, key) => value?.[key], document);
}

function matches(document, filter) {
	return Object.entries(filter || {}).every(([key, expected]) => {
		if (key === "$expr") return true;
		const actual = getDotted(document, key);
		return expected instanceof mongoose.Types.ObjectId
			? id(actual) === id(expected)
			: actual === expected;
	});
}

class FakeCollection {
	constructor(name, documents, control) {
		this.name = name;
		this.control = control;
		this.documents = new Map(documents.map((document) => [id(document._id), document]));
		this.insertOneCalls = 0;
		this.replaceOneCalls = 0;
		this.updateOneCalls = 0;
		this.lastFindOptions = null;
	}

	async findOne(filter, options) {
		this.lastFindOptions = options || null;
		if (this.control.throwNextRead) {
			this.control.throwNextRead = false;
			throw new Error("injected exact readback failure");
		}
		if (filter._id != null) return this.documents.get(id(filter._id)) || null;
		return [...this.documents.values()].find((document) => matches(document, filter)) || null;
	}

	async insertOne(document, options) {
		this.insertOneCalls += 1;
		assert.deepEqual(options.writeConcern, { w: "majority" });
		const key = id(document._id);
		if (this.documents.has(key)) {
			const error = new Error("duplicate key");
			error.code = 11000;
			throw error;
		}
		this.documents.set(key, document);
		return { acknowledged: true, insertedId: document._id };
	}

	async replaceOne(filter, replacement, options) {
		this.replaceOneCalls += 1;
		this.control.replaceCount += 1;
		this.control.operations.push(`${this.name}:${id(replacement._id)}`);
		assert.deepEqual(options.writeConcern, { w: "majority" });
		if (
			this.control.failAt === this.control.replaceCount &&
			!this.control.failureConsumed
		) {
			this.control.failureConsumed = true;
			return { matchedCount: 0, modifiedCount: 0 };
		}
		const entries = filter?.$expr?.$eq?.[1]?.$literal;
		const expected = Object.fromEntries(entries.map((entry) => [entry.k, entry.v]));
		const current = this.documents.get(id(expected._id));
		if (!current || canonicalEjsonSha256(current) !== canonicalEjsonSha256(expected)) {
			return { matchedCount: 0, modifiedCount: 0 };
		}
		this.documents.set(id(replacement._id), replacement);
		if (this.control.readbackFailureAtReplace === this.control.replaceCount) {
			this.control.throwNextRead = true;
		}
		return { matchedCount: 1, modifiedCount: 1 };
	}

	async updateOne(filter, update, options) {
		this.updateOneCalls += 1;
		assert.deepEqual(options.writeConcern, { w: "majority" });
		const current = [...this.documents.values()].find((document) =>
			matches(document, filter)
		);
		if (!current) return { matchedCount: 0, modifiedCount: 0 };
		this.documents.set(id(current._id), applyUpdateToDocument(current, update));
		return { matchedCount: 1, modifiedCount: 1 };
	}
}

function fixtureCollections({ failAt = 0, readbackFailureAtReplace = 0 } = {}) {
	const fixtures = TARGETS.map(targetFixture);
	const control = {
		failAt,
		readbackFailureAtReplace,
		replaceCount: 0,
		failureConsumed: false,
		throwNextRead: false,
		operations: [],
	};
	const collection = (name, documents = []) => new FakeCollection(name, documents, control);
	return {
		fixtures,
		control,
		collections: {
			events: collection("events", fixtures.map((fixture) => fixture.event)),
			mirrors: collection("mirrors", fixtures.map((fixture) => fixture.mirror)),
			jobs: collection("jobs", fixtures.map((fixture) => fixture.job)),
			audits: collection("audits", fixtures.map((fixture) => fixture.audit)),
			reservations: collection("reservations"),
			backups: collection("backups"),
		},
	};
}

async function dryProof(collections) {
	return proofToken(
		buildPlan(await loadScopes(collections), PLAN_AT, RELEASE_SHA)
	);
}

test("scope is exactly the two observed half-cent incidents", () => {
	assert.equal(SCOPE_ATTESTATION, "1658113971008322,1567954036129867");
	assert.deepEqual(
		TARGETS.map((target) => [
			target.eventId,
			target.mirrorId,
			target.jobId,
			target.auditId,
			target.preallocatedReservationId,
		]),
		[
			[
				"6a7ad033d8cbed2f4bad478c",
				"6a7ad03459d8ef904b9c8d71",
				"6a7ad012d8cbed2f4bad478b",
				"6a7ad00ed8921baafa81f9f2",
				"6a7ad03959d8ef904b9c8d7f",
			],
			[
				"6a7b5235d8cbed2f4bad47a4",
				"6a7b523559d8ef904b9de5de",
				"6a7b5233d8cbed2f4bad47a3",
				"6a7b5230d8921baafa82bf6a",
				"6a7b523a59d8ef904b9de5eb",
			],
		]
	);
});

test("the utility has no PMS reservation or mirror write path", () => {
	const source = fs.readFileSync(
		path.resolve(__dirname, "recoverHotelRunnerHalfCentProjection20260811.js"),
		"utf8"
	);
	assert.doesNotMatch(source, /collections\.reservations\.(?:insert|update|replace)/);
	assert.doesNotMatch(source, /collections\.mirrors\.(?:insert|update|replace)/);
});

test("apply requires proof, exact scope, release, and stopped-worker attestations", () => {
	assert.deepEqual(parseArguments([]), {
		apply: false,
		help: false,
		repairId: "",
		scope: "",
		proof: "",
		releaseSha: "",
		workerStopped: "",
	});
	assert.throws(() => parseArguments(["--apply"]), {
		code: "HOTELRUNNER_HALF_CENT_RECOVERY_REPAIR_ID_REQUIRED",
	});
	const proof = `${PLAN_AT.getTime()}.${hash("a")}`;
	const parsed = parseArguments([
		"--apply",
		`--repair-id=${REPAIR_ID}`,
		`--scope=${SCOPE_ATTESTATION}`,
		`--proof=${proof}`,
		`--release-sha=${RELEASE_SHA}`,
		`--worker-stopped=${WORKER_UNIT}`,
	]);
	assert.equal(parsed.apply, true);
	assert.equal(parsed.proof, proof);
});

test("proofs are bounded and reject expiry", () => {
	const proof = `${PLAN_AT.getTime()}.${hash("b")}`;
	assert.equal(parseProof(proof, APPLY_AT).plannedAt.getTime(), PLAN_AT.getTime());
	assert.throws(
		() => parseProof(proof, new Date(PLAN_AT.getTime() + 31 * 60_000)),
		{ code: "HOTELRUNNER_HALF_CENT_RECOVERY_PROOF_EXPIRED" }
	);
});

test("dry run is write-free and returns a scope-bound proof", async () => {
	const { collections } = fixtureCollections();
	const output = await main([], {
		skipConnect: true,
		collections,
		clock: () => PLAN_AT,
		resolveReleaseAttestation: () => releaseAttestation(),
	});
	assert.equal(output.mode, "dry_run");
	assert.match(output.proof, new RegExp(`^${PLAN_AT.getTime()}\\.[a-f0-9]{64}$`));
	assert.equal(collections.backups.insertOneCalls, 0);
	assert.equal(collections.events.replaceOneCalls, 0);
	assert.equal(collections.jobs.replaceOneCalls, 0);
	assert.equal(collections.audits.replaceOneCalls, 0);
	assert.equal(collections.events.lastFindOptions.readPreference, "primary");
	assert.equal(collections.events.lastFindOptions.readConcern.level, "local");
	assert.equal(collections.events.lastFindOptions.promoteValues, false);
});

test("topology gate accepts only a standalone writable primary", async () => {
	assert.equal(
		await assertStandaloneWritablePrimary({
			command: async () => ({ ok: 1, isWritablePrimary: true }),
		}),
		true
	);
	await assert.rejects(
		() =>
			assertStandaloneWritablePrimary({
				command: async () => ({
					ok: 1,
					isWritablePrimary: true,
					setName: "rs0",
				}),
			}),
		{ code: "HOTELRUNNER_HALF_CENT_RECOVERY_TOPOLOGY_UNATTESTED" }
	);
});

test("durable backup creation is idempotent only for the exact same scope", async () => {
	const { collections } = fixtureCollections();
	const plan = buildPlan(await loadScopes(collections), PLAN_AT, RELEASE_SHA);
	assert.equal(await ensureBackups(collections, plan, APPLY_AT), 6);
	assert.equal(await ensureBackups(collections, plan, APPLY_AT), 6);
	assert.equal(collections.backups.documents.size, 6);
	assert.equal(collections.backups.insertOneCalls, 6);
	const first = collections.backups.documents.values().next().value;
	first.scopeHash = hash("f");
	await assert.rejects(() => ensureBackups(collections, plan, APPLY_AT), {
		code: "HOTELRUNNER_HALF_CENT_RECOVERY_BACKUP_INVALID",
	});
});

test("unexpected terminal evidence fails closed before backup or CAS", async () => {
	const { collections } = fixtureCollections();
	collections.events.documents.get(TARGETS[0].eventId).errorCode = "different";
	await assert.rejects(() => loadScopes(collections).then((scopes) => buildPlan(scopes, PLAN_AT, RELEASE_SHA)), {
		code: "HOTELRUNNER_HALF_CENT_RECOVERY_SCOPE_DRIFT",
	});
	assert.equal(collections.backups.insertOneCalls, 0);
});

test("reservation absence checks include HR aliases and HotelRunner metadata aliases", async () => {
	for (const reservation of [
		{
			_id: oid("6a7ad03959d8ef904b9de5ec"),
			hotelId: oid(TARGETS[0].hotelId),
			hr_number: TARGETS[0].hrNumber,
		},
		{
			_id: oid("6a7ad03959d8ef904b9de5ed"),
			hotelId: oid(TARGETS[0].hotelId),
			supplierData: {
				hotelRunner: { providerNumber: TARGETS[0].confirmationNumber },
			},
		},
	]) {
		const { collections } = fixtureCollections();
		collections.reservations.documents.set(id(reservation._id), reservation);
		await assert.rejects(
			() =>
				loadScopes(collections).then((scopes) =>
					buildPlan(scopes, PLAN_AT, RELEASE_SHA)
				),
			{ code: "HOTELRUNNER_HALF_CENT_RECOVERY_SCOPE_DRIFT" }
		);
	}
});

test("the dry-run proof is bound to the exact clean release", async () => {
	const { collections } = fixtureCollections();
	const proof = await dryProof(collections);
	await assert.rejects(
		() =>
			applyRecovery({
				collections,
				proof,
				releaseSha: "c".repeat(40),
				now: APPLY_AT,
				resolveReleaseAttestation: () =>
					releaseAttestation("c".repeat(40)),
				assertWorkerStopped: () => true,
				ownerToken: "d".repeat(64),
			}),
		{ code: "HOTELRUNNER_HALF_CENT_RECOVERY_PROOF_MISMATCH" }
	);
});

test("apply durably backs up six documents and releases events last", async () => {
	const { collections, control, fixtures } = fixtureCollections();
	const mirrorHashes = fixtures.map((fixture) => canonicalEjsonSha256(fixture.mirror));
	let workerChecks = 0;
	const result = await applyRecovery({
		collections,
		proof: await dryProof(collections),
		releaseSha: RELEASE_SHA,
		now: APPLY_AT,
		resolveReleaseAttestation: () => releaseAttestation(),
		assertWorkerStopped: () => {
			workerChecks += 1;
			return true;
		},
		ownerToken: "c".repeat(64),
	});
	assert.equal(result.changed, 6);
	assert.equal(result.backupCount, 6);
	assert.equal(collections.backups.documents.size, 7);
	assert.equal(workerChecks, 3);
	for (const target of TARGETS) {
		assert.equal(collections.jobs.documents.get(target.jobId).status, "awaiting_hotelrunner");
		assert.equal(collections.audits.documents.get(target.auditId).processingStatus, "awaiting_hotelrunner");
		assert.equal(collections.events.documents.get(target.eventId).status, "pending");
		assert.equal(Number(collections.events.documents.get(target.eventId).__v), 1);
		assert.equal(
			collections.events.documents.get(target.eventId).result.status,
			"pending"
		);
		assert.equal(
			collections.events.documents.get(target.eventId).nextAttemptAt.getTime(),
			APPLY_AT.getTime() + 2 * 60_000
		);
		assert.equal(
			collections.jobs.documents.get(target.jobId).nextAttemptAt.getTime(),
			APPLY_AT.getTime() + 5 * 60_000
		);
	}
	assert.deepEqual(
		fixtures.map((fixture) =>
			canonicalEjsonSha256(collections.mirrors.documents.get(fixture.target.mirrorId))
		),
		mirrorHashes
	);
	assert.equal(collections.reservations.replaceOneCalls, 0);
	assert.deepEqual(
		control.operations.slice(-2).map((entry) => entry.split(":")[0]),
		["events", "events"]
	);
});

test("release mismatch fails before durable or operational writes", async () => {
	const { collections } = fixtureCollections();
	const proof = await dryProof(collections);
	await assert.rejects(
		() =>
			applyRecovery({
				collections,
				proof,
				releaseSha: RELEASE_SHA,
				now: APPLY_AT,
				resolveReleaseAttestation: () => releaseAttestation("c".repeat(40)),
		assertWorkerStopped: () => true,
		ownerToken: "c".repeat(64),
			}),
		{ code: "HOTELRUNNER_HALF_CENT_RECOVERY_RELEASE_MISMATCH" }
	);
	assert.equal(collections.backups.insertOneCalls, 0);
});

test("a dirty release attestation aborts before backup creation", async () => {
	const { collections } = fixtureCollections();
	const proof = await dryProof(collections);
	const dirty = new Error("dirty tracked checkout");
	dirty.code = "HOTELRUNNER_RELEASE_TRACKED_CHECKOUT_DIRTY";
	await assert.rejects(
		() =>
			applyRecovery({
				collections,
				proof,
				releaseSha: RELEASE_SHA,
				now: APPLY_AT,
				resolveReleaseAttestation: () => {
					throw dirty;
				},
				assertWorkerStopped: () => true,
			}),
		{ code: "HOTELRUNNER_RELEASE_TRACKED_CHECKOUT_DIRTY" }
	);
	assert.equal(collections.backups.insertOneCalls, 0);
});

test("a second owner cannot enter the CAS section for the same proof", async () => {
	const { collections } = fixtureCollections();
	const proof = await dryProof(collections);
	collections.backups.documents.set(`${REPAIR_ID}:apply-lock`, {
		_id: `${REPAIR_ID}:apply-lock`,
		repairId: REPAIR_ID,
		state: "active",
		ownerToken: "e".repeat(64),
		scopeHash: proof.split(".")[1],
		leaseUntil: new Date(APPLY_AT.getTime() + 60_000),
	});
	await assert.rejects(
		() =>
			applyRecovery({
				collections,
				proof,
				releaseSha: RELEASE_SHA,
				now: APPLY_AT,
				resolveReleaseAttestation: () => releaseAttestation(),
				assertWorkerStopped: () => true,
				ownerToken: "f".repeat(64),
			}),
		{ code: "HOTELRUNNER_HALF_CENT_RECOVERY_LOCK_HELD" }
	);
	assert.equal(collections.jobs.replaceOneCalls, 0);
	assert.equal(collections.audits.replaceOneCalls, 0);
	assert.equal(collections.events.replaceOneCalls, 0);
});

test("a partial CAS failure compensates every changed document exactly", async () => {
	const { collections, fixtures } = fixtureCollections({ failAt: 4 });
	const proof = await dryProof(collections);
	const originalHashes = new Map();
	for (const fixture of fixtures) {
		for (const role of ["event", "job", "audit"]) {
			originalHashes.set(
				`${fixture.target.key}:${role}`,
				canonicalEjsonSha256(fixture[role])
			);
		}
	}
	await assert.rejects(
		() =>
			applyRecovery({
				collections,
				proof,
				releaseSha: RELEASE_SHA,
				now: APPLY_AT,
				resolveReleaseAttestation: () => releaseAttestation(),
				assertWorkerStopped: () => true,
				ownerToken: "c".repeat(64),
			}),
		{ code: "HOTELRUNNER_HALF_CENT_RECOVERY_COMPENSATED" }
	);
	for (const fixture of fixtures) {
		assert.equal(
			canonicalEjsonSha256(collections.events.documents.get(fixture.target.eventId)),
			originalHashes.get(`${fixture.target.key}:event`)
		);
		assert.equal(
			canonicalEjsonSha256(collections.jobs.documents.get(fixture.target.jobId)),
			originalHashes.get(`${fixture.target.key}:job`)
		);
		assert.equal(
			canonicalEjsonSha256(collections.audits.documents.get(fixture.target.auditId)),
			originalHashes.get(`${fixture.target.key}:audit`)
		);
	}
	assert.equal(collections.backups.documents.size, 7);
	assert.equal(
		collections.backups.documents.get(`${REPAIR_ID}:apply-lock`).state,
		"compensated"
	);
});

test("an acknowledgement readback error enters compensation and restores the write", async () => {
	const { collections: live, fixtures: liveFixtures } = fixtureCollections({
		readbackFailureAtReplace: 1,
	});
	const proof = await dryProof(live);
	await assert.rejects(
		() =>
			applyRecovery({
				collections: live,
				proof,
				releaseSha: RELEASE_SHA,
				now: APPLY_AT,
				resolveReleaseAttestation: () => releaseAttestation(),
				assertWorkerStopped: () => true,
				ownerToken: "c".repeat(64),
			}),
		{ code: "HOTELRUNNER_HALF_CENT_RECOVERY_COMPENSATED" }
	);
	assert.equal(
		canonicalEjsonSha256(live.jobs.documents.get(TARGETS[0].jobId)),
		canonicalEjsonSha256(liveFixtures[0].job)
	);
});

test("BSON update projection preserves unknown fields while unsetting terminal leases", () => {
	const original = {
		_id: oid(TARGETS[0].jobId),
		__v: 0,
		status: "needs_review",
		leaseOwner: "stale",
		protectedUnknown: { cents: 10897 },
	};
	const projected = applyUpdateToDocument(original, {
		$set: { status: "awaiting_hotelrunner" },
		$unset: { leaseOwner: "" },
		$inc: { __v: 1 },
	});
	assert.equal(projected.status, "awaiting_hotelrunner");
	assert.equal(projected.leaseOwner, undefined);
	assert.equal(Number(projected.protectedUnknown.cents), 10897);
	assert.equal(Number(projected.__v), 1);
});

test("backup collection name is versioned and incident-specific", () => {
	assert.equal(
		BACKUP_COLLECTION,
		"ota_hotelrunner_half_cent_projection_backup_20260811_v1"
	);
});
