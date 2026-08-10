/** @format */

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const mongoose = require("mongoose");
const BSON = require("bson");

const {
	AWAITING_MESSAGE,
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
	applyPlan,
	applyPlanStandalone,
	assertPostconditions,
	buildAuditReopenUpdate,
	buildJobReopenUpdate,
	buildPlan,
	buildTerminalAuditFilter,
	buildTerminalJobFilter,
	buildFullDocumentCasFilter,
	canonicalEjsonSha256,
	classifyScope,
	cloneFullBson,
	loadScopes,
	parseArguments,
	resolveApplyStrategy,
} = require("./recoverHotelRunnerStaleMappingEvents20260810");

const APPLY_AT = new Date("2026-08-10T16:00:00.000Z");
const RUN_ID = "a".repeat(32);
const LEASE_UNTIL = new Date(APPLY_AT.getTime() + SERIAL_LEASE_MS);

const oid = (value) => new mongoose.Types.ObjectId(value);
const id = (value) => String(value?._id || value || "").toLowerCase();
const dateMs = (value) => new Date(value).getTime();

function terminalScope(target) {
	const hashSeed = target.confirmationNumber.slice(-1) || "a";
	const hash = (offset = 0) =>
		((Number(hashSeed) + offset) % 10).toString().repeat(64);
	const event = {
		_id: oid(target.eventId),
		hotelId: oid(target.hotelId),
		hotelRunnerReservationId: target.hotelRunnerReservationId,
		hrNumber: target.hrNumber,
		providerNumber: target.confirmationNumber,
		channel: target.channel,
		state: "confirmed",
		status: "needs_mapping",
		attempts: 1,
		errorCode: STALE_MAPPING_CODE,
		reservationMongoId: null,
		mirrorId: oid(target.mirrorId),
		receivedAt: new Date(target.eventReceivedAt),
		sourceUpdatedAt: new Date(target.eventSourceUpdatedAt),
		updatedAt: new Date(target.eventUpdatedAt),
		result: {
			status: "needs_mapping",
			code: STALE_MAPPING_CODE,
			missingInvCodes: [target.staleInvCode],
			staleInvCodes: [target.staleInvCode],
		},
	};
	const mirror = {
		_id: oid(target.mirrorId),
		hotelId: oid(target.hotelId),
		hotelRunnerReservationId: target.hotelRunnerReservationId,
		hrNumber: target.hrNumber,
		providerNumber: target.confirmationNumber,
		channel: target.channel,
		state: "confirmed",
		projectionStatus: "needs_mapping",
		lastErrorCode: STALE_MAPPING_CODE,
		reservationMongoId: null,
	};
	const job = {
		_id: oid(target.jobId),
		__v: 0,
		hotelId: oid(target.hotelId),
		provider: target.provider,
		confirmationNumber: target.confirmationNumber,
		identityKey: target.identityKey,
		inboundEmailId: oid(target.auditId),
		inboundEmailHash: hash(1),
		archiveFingerprint: hash(2),
		normalizedReservationHash: hash(3),
		resolvedHotelProofHash: hash(4),
		status: "needs_review",
		attemptCount: 1,
		lookupAttemptCount: 0,
		lastDecision: TERMINAL_DECISION,
		lastErrorCode: TERMINAL_CODE,
		lastErrorMessage: TERMINAL_MESSAGE,
		completedAt: new Date(target.terminalAt),
		updatedAt: new Date(target.jobUpdatedAt),
		inboundAuditFinalizationStatus: "completed",
		inboundAuditFinalizedAt: new Date(target.terminalAt),
		ingressDecision: {
			status: "api_observed",
			apiObservationCount: 1,
			apiObservedAt: new Date(target.eventReceivedAt),
		},
		reservationMongoId: null,
		hotelRunnerEventId: null,
		hotelRunnerMirrorId: null,
		identityConflict: false,
		result: {
			status: "needs_mapping",
			code: STALE_MAPPING_CODE,
			eventId: target.eventId,
			mirrorId: target.mirrorId,
		},
	};
	const audit = {
		_id: oid(target.auditId),
		__v: 0,
		hotelId: oid(target.hotelId),
		provider: target.provider,
		confirmationNumber: target.confirmationNumber,
		intent: "new_reservation",
		eventType: "new",
		emailHash: job.inboundEmailHash,
		processingStatus: "needs_review",
		automationAction: "skipped",
		skipReason: "hotelrunner_local_record_blocked",
		automationComment: TERMINAL_MESSAGE,
		hasReservationConnection: false,
		reservationMongoId: null,
		pmsConfirmationNumber: "",
		matchedReservationBy: [],
		reconcileWarnings: [],
		reconcileErrors: [TERMINAL_MESSAGE],
		updatedAt: new Date(target.auditUpdatedAt),
		senderAuthentication: {
			authenticatedAligned: true,
			trustedProvider: target.provider,
		},
		normalizedReservation: {
			provider: target.provider,
			confirmationNumber: target.confirmationNumber,
			reservationId: target.confirmationNumber,
			intent: "new_reservation",
			eventType: "new",
			inboundEmailId: target.auditId,
			sourceSenderAuthenticated: true,
			sourceSenderTrusted: true,
			trustedTransportProvider: target.provider,
			sourcePresence: {
				hotelName: true,
				roomName: true,
				checkinDate: true,
				checkoutDate: true,
				roomCount: true,
				amount: true,
			},
		},
		hotelRunnerFirstFallback: {
			eligible: true,
			status: "needs_review",
			jobId: target.jobId,
			collision: false,
			lastErrorCode: TERMINAL_CODE,
			lastErrorMessage: TERMINAL_MESSAGE,
			finalizedAt: new Date(target.terminalAt),
			resolvedHotelProof: { version: 1, hotelId: target.hotelId },
		},
		reconciliation: {
			status: "needs_review",
			actionTaken: "skipped",
			skipReason: "hotelrunner_local_record_blocked",
			automationComment: TERMINAL_MESSAGE,
			reservationId: null,
			hotelId: oid(target.hotelId),
			provider: target.provider,
			confirmationNumber: target.confirmationNumber,
			hotelRunnerFirstFallback: {
				version: 1,
				jobId: target.jobId,
				status: "needs_review",
				decision: TERMINAL_DECISION,
			},
		},
	};
	return { target, event, mirror, job, audit };
}

const getPath = (object, dotted) =>
	dotted.split(".").reduce((value, key) => value?.[key], object);

function setPath(object, dotted, value) {
	const parts = dotted.split(".");
	const final = parts.pop();
	let cursor = object;
	for (const part of parts) {
		if (!cursor[part] || typeof cursor[part] !== "object") cursor[part] = {};
		cursor = cursor[part];
	}
	cursor[final] = value;
}

function unsetPath(object, dotted) {
	const parts = dotted.split(".");
	const final = parts.pop();
	const parent = parts.reduce((value, key) => value?.[key], object);
	if (parent && typeof parent === "object") delete parent[final];
}

function sameValue(actual, expected) {
	if (expected instanceof Date) return dateMs(actual) === expected.getTime();
	if (expected instanceof mongoose.Types.ObjectId)
		return id(actual) === id(expected);
	if (Array.isArray(expected)) {
		return (
			Array.isArray(actual) &&
			actual.length === expected.length &&
			actual.every((value, index) => sameValue(value, expected[index]))
		);
	}
	if (expected && typeof expected === "object") {
		if (!actual || typeof actual !== "object") return false;
		const expectedKeys = Object.keys(expected);
		const actualKeys = Object.keys(actual);
		return (
			actualKeys.length === expectedKeys.length &&
			expectedKeys.every(
				(key) =>
					Object.prototype.hasOwnProperty.call(actual, key) &&
					sameValue(actual[key], expected[key])
			)
		);
	}
	return actual === expected;
}

function matches(document, filter) {
	return Object.entries(filter).every(([key, expected]) =>
		sameValue(getPath(document, key), expected)
	);
}

function applyUpdate(document, update) {
	for (const [key, value] of Object.entries(update.$set || {})) {
		setPath(document, key, value);
	}
	for (const key of Object.keys(update.$unset || {})) unsetPath(document, key);
	for (const [key, instruction] of Object.entries(update.$push || {})) {
		const current = Array.isArray(getPath(document, key))
			? [...getPath(document, key)]
			: [];
		const additions = Array.isArray(instruction?.$each)
			? instruction.$each
			: [instruction];
		current.push(...additions);
		const sliced = Number.isInteger(instruction?.$slice)
			? instruction.$slice < 0
				? current.slice(instruction.$slice)
				: current.slice(0, instruction.$slice)
			: current;
		setPath(document, key, sliced);
	}
	for (const [key, increment] of Object.entries(update.$inc || {})) {
		setPath(document, key, Number(getPath(document, key) || 0) + increment);
	}
}

class FakeCollection {
	constructor(documents, { role = "", onReplace = null, onFind = null } = {}) {
		this.documents = new Map(
			documents.map((document) => [id(document._id), document])
		);
		this.role = role;
		this.onReplace = onReplace;
		this.onFind = onFind;
		this.findOneCalls = 0;
		this.updateOneCalls = 0;
		this.replaceOneCalls = 0;
	}

	async findOne(filter, options) {
		this.findOneCalls += 1;
		if (this.onFind) await this.onFind({ collection: this, filter, options });
		return this.documents.get(id(filter._id)) || null;
	}

	async updateOne(filter, update) {
		this.updateOneCalls += 1;
		const document = this.documents.get(id(filter._id));
		if (!document || !matches(document, filter)) {
			return { matchedCount: 0, modifiedCount: 0 };
		}
		applyUpdate(document, update);
		return { matchedCount: 1, modifiedCount: 1 };
	}

	async replaceOne(filter, replacement, options) {
		this.replaceOneCalls += 1;
		const document = this.documents.get(id(filter._id));
		const entries = filter?.$expr?.$eq?.[1]?.$literal;
		const exactBefore = Array.isArray(entries)
			? Object.fromEntries(entries.map(({ k, v }) => [k, v]))
			: null;
		const context = {
			collection: this,
			filter,
			replacement,
			options,
			phase: "before",
		};
		if (this.onReplace) await this.onReplace(context);
		if (
			!document ||
			!exactBefore ||
			canonicalEjsonSha256(document) !== canonicalEjsonSha256(exactBefore)
		) {
			return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
		}
		this.documents.set(id(filter._id), cloneFullBson(replacement));
		if (this.onReplace) {
			await this.onReplace({ ...context, phase: "after" });
		}
		return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
	}
}

function fixtureCollections(options = {}) {
	const scopes = TARGETS.map(terminalScope);
	return {
		scopes,
		collections: {
			events: new FakeCollection(
				scopes.map((scope) => scope.event),
				{
					role: "events",
					...options.events,
				}
			),
			mirrors: new FakeCollection(
				scopes.map((scope) => scope.mirror),
				{
					role: "mirrors",
					...options.mirrors,
				}
			),
			jobs: new FakeCollection(
				scopes.map((scope) => scope.job),
				{
					role: "jobs",
					...options.jobs,
				}
			),
			audits: new FakeCollection(
				scopes.map((scope) => scope.audit),
				{
					role: "audits",
					...options.audits,
				}
			),
		},
	};
}

const isForwardReplacement = (collection, replacement) =>
	collection.role === "audits"
		? replacement.processingStatus === "awaiting_hotelrunner"
		: collection.role === "jobs" &&
		  replacement.status === "awaiting_hotelrunner";

function exactCollectionHashes(collections) {
	return {
		jobs: Array.from(collections.jobs.documents.values()).map(
			canonicalEjsonSha256
		),
		audits: Array.from(collections.audits.documents.values()).map(
			canonicalEjsonSha256
		),
		events: Array.from(collections.events.documents.values()).map(
			canonicalEjsonSha256
		),
		mirrors: Array.from(collections.mirrors.documents.values()).map(
			canonicalEjsonSha256
		),
	};
}

function simulateKilledAfterAuditPhase(collections, serialRunId = RUN_ID) {
	for (const target of TARGETS) {
		const job = collections.jobs.documents.get(target.jobId);
		const audit = collections.audits.documents.get(target.auditId);
		applyUpdate(
			audit,
			buildAuditReopenUpdate(
				target,
				APPLY_AT,
				{ job, audit },
				serialRunId,
				LEASE_UNTIL
			)
		);
	}
}

test("scope is exactly the four confirmed stale-mapping identities", () => {
	assert.equal(TARGETS.length, 4);
	assert.deepEqual(
		TARGETS.map((target) => target.eventId),
		[
			"6a798f9ad8cbed2f4bad4752",
			"6a79a193d8cbed2f4bad4754",
			"6a79b035d8cbed2f4bad4756",
			"6a79e024d8cbed2f4bad475b",
		]
	);
	assert.deepEqual(
		TARGETS.map((target) => target.provider),
		["agoda", "trip", "agoda", "agoda"]
	);
	assert.ok(
		TARGETS.every(
			(target) =>
				target.identityKey === `${target.provider}:${target.confirmationNumber}`
		)
	);
});

test("script has no PMS reservation model or collection access", () => {
	const source = fs.readFileSync(
		path.resolve(__dirname, "recoverHotelRunnerStaleMappingEvents20260810.js"),
		"utf8"
	);
	assert.doesNotMatch(source, /require\(["']\.\.\/models\/reservations["']\)/i);
	assert.doesNotMatch(source, /collection\(["']reservations["']\)/i);
});

test("argument parser is dry-run by default and modes are exclusive", () => {
	assert.deepEqual(parseArguments([]), {
		apply: false,
		postconditions: false,
		help: false,
		repairId: "",
	});
	assert.equal(
		parseArguments(["--apply", `--repair-id=${RECOVERY_ID}`]).apply,
		true
	);
	assert.equal(parseArguments(["--postconditions"]).postconditions, true);
	assert.throws(
		() => parseArguments(["--apply"]),
		(error) =>
			error.code === "HOTELRUNNER_STALE_MAPPING_RECOVERY_REPAIR_ID_REQUIRED"
	);
	assert.throws(
		() => parseArguments([`--repair-id=${RECOVERY_ID}`]),
		(error) =>
			error.code === "HOTELRUNNER_STALE_MAPPING_RECOVERY_REPAIR_ID_UNEXPECTED"
	);
	assert.throws(
		() =>
			parseArguments([
				"--apply",
				`--repair-id=${RECOVERY_ID}`,
				"--postconditions",
			]),
		(error) => error.code === "HOTELRUNNER_STALE_MAPPING_RECOVERY_MODE_CONFLICT"
	);
	assert.throws(
		() => parseArguments(["--force"]),
		(error) =>
			error.code === "HOTELRUNNER_STALE_MAPPING_RECOVERY_ARGUMENT_INVALID"
	);
});

test("exact production-shaped terminal state plans four reopen actions", () => {
	const scopes = TARGETS.map(terminalScope);
	for (const scope of scopes) {
		assert.deepEqual(classifyScope(scope), {
			state: "terminal_stale_mapping",
			errors: [],
		});
	}
	const plan = buildPlan(scopes, APPLY_AT);
	assert.equal(plan.targets.length, 4);
	assert.equal(plan.actions.length, 4);
	assert.throws(
		() => assertPostconditions(plan),
		(error) =>
			error.code === "HOTELRUNNER_STALE_MAPPING_RECOVERY_POSTCONDITION_FAILED"
	);
});

test("any identity or expected terminal drift fails closed", () => {
	const scopes = TARGETS.map(terminalScope);
	scopes[2].job.lastErrorCode = "A_DIFFERENT_ERROR";
	assert.equal(classifyScope(scopes[2]).state, "drift");
	assert.throws(
		() => buildPlan(scopes, APPLY_AT),
		(error) =>
			error.code === "HOTELRUNNER_STALE_MAPPING_RECOVERY_SCOPE_DRIFT" &&
			error.message.includes("agoda_2040072127")
	);
});

test("reopen updates clear only terminal queue/audit lifecycle with a hold", () => {
	const target = TARGETS[0];
	const scope = terminalScope(target);
	const jobUpdate = buildJobReopenUpdate(APPLY_AT, RUN_ID, LEASE_UNTIL);
	const auditUpdate = buildAuditReopenUpdate(
		target,
		APPLY_AT,
		scope,
		RUN_ID,
		LEASE_UNTIL
	);
	assert.equal(jobUpdate.$set.status, "awaiting_hotelrunner");
	assert.equal(jobUpdate.$set.lastDecision, REOPEN_DECISION);
	assert.equal(jobUpdate.$set.attemptCount, 0);
	assert.equal(
		jobUpdate.$set.nextAttemptAt.getTime(),
		APPLY_AT.getTime() + RECOVERY_HOLD_MS
	);
	assert.equal(auditUpdate.$set.processingStatus, "awaiting_hotelrunner");
	assert.equal(auditUpdate.$set.automationAction, "queued");
	assert.equal(auditUpdate.$set.automationComment, AWAITING_MESSAGE);
	assert.equal(
		auditUpdate.$set["hotelRunnerFirstFallback.recoveryId"],
		RECOVERY_ID
	);
	assert.equal(auditUpdate.$set["reconciliation.hotelRunnerFirst"], true);
	assert.equal(
		auditUpdate.$push["hotelRunnerFirstFallback.recoveryHistory"].$each[0]
			.previousTerminal.code,
		TERMINAL_CODE
	);
	assert.deepEqual(
		auditUpdate.$push["hotelRunnerFirstFallback.recoveryHistory"].$each[0]
			.previousTerminal.jobResult,
		scope.job.result
	);
	assert.deepEqual(
		auditUpdate.$push["hotelRunnerFirstFallback.recoveryHistory"].$each[0]
			.previousTerminal.reconciliationHotelRunnerFirstFallback,
		scope.audit.reconciliation.hotelRunnerFirstFallback
	);
	assert.equal(
		Object.prototype.hasOwnProperty.call(jobUpdate.$set, "result"),
		false
	);
	assert.equal(auditUpdate.$inc.__v, 1);
	assert.equal(jobUpdate.$inc.__v, 1);
});

test("terminal CAS binds the full diagnostic objects that recovery will replace", () => {
	const scope = terminalScope(TARGETS[0]);
	const jobFilter = buildTerminalJobFilter(scope.target, scope.job);
	const auditFilter = buildTerminalAuditFilter(scope.target, scope.audit);
	assert.equal(matches(scope.job, jobFilter), true);
	assert.equal(matches(scope.audit, auditFilter), true);

	scope.job.result.code = "concurrent_diagnostic_change";
	scope.audit.reconciliation.hotelRunnerFirstFallback.concurrentNote = true;
	assert.equal(matches(scope.job, jobFilter), false);
	assert.equal(matches(scope.audit, auditFilter), false);
});

test("apply is transactional, changes four job/audit pairs, and never changes events/mirrors", async () => {
	const fixture = fixtureCollections();
	const { collections } = fixture;
	const eventBefore = JSON.stringify(
		Array.from(collections.events.documents.values())
	);
	const mirrorBefore = JSON.stringify(
		Array.from(collections.mirrors.documents.values())
	);
	let transactionCalls = 0;
	const applied = await applyPlan({
		collections,
		appliedAt: APPLY_AT,
		runTransaction: async (work) => {
			transactionCalls += 1;
			return work({ testSession: true });
		},
	});
	assert.equal(transactionCalls, 1);
	assert.equal(applied.changed, 4);
	assert.ok(
		applied.plan.targets.every(
			(entry) => entry.state === "reopened_waiting_mapping"
		)
	);
	assert.equal(collections.jobs.updateOneCalls, 4);
	assert.equal(collections.audits.updateOneCalls, 4);
	assert.equal(collections.events.updateOneCalls, 0);
	assert.equal(collections.mirrors.updateOneCalls, 0);
	assert.equal(
		JSON.stringify(Array.from(collections.events.documents.values())),
		eventBefore
	);
	assert.equal(
		JSON.stringify(Array.from(collections.mirrors.documents.values())),
		mirrorBefore
	);
	assertPostconditions(applied.plan);

	for (const target of TARGETS) {
		const job = collections.jobs.documents.get(target.jobId);
		const audit = collections.audits.documents.get(target.auditId);
		const originalScope = fixture.scopes.find(
			(scope) => scope.target.jobId === target.jobId
		);
		assert.equal(job.status, "awaiting_hotelrunner");
		assert.equal(job.__v, 1);
		assert.equal(job.completedAt, undefined);
		assert.equal(audit.processingStatus, "awaiting_hotelrunner");
		assert.equal(audit.__v, 1);
		assert.equal(audit.hotelRunnerFirstFallback.status, "enqueued");
		assert.equal(audit.hotelRunnerFirstFallback.finalizedAt, undefined);
		assert.equal(audit.hotelRunnerFirstFallback.recoveryHistory.length, 1);
		assert.deepEqual(
			job.result,
			originalScope.job.result,
			"the operational job result is preserved until the worker replaces it"
		);
		assert.deepEqual(
			audit.hotelRunnerFirstFallback.recoveryHistory[0].previousTerminal
				.jobResult,
			originalScope.job.result
		);
		assert.equal(
			audit.hotelRunnerFirstFallback.recoveryHistory[0].previousTerminal
				.decision,
			TERMINAL_DECISION
		);
		assert.equal(audit.reconciliation.hotelRunnerFirstFallback, undefined);
	}
});

test("a second apply is an idempotent no-op", async () => {
	const { collections } = fixtureCollections();
	const transaction = async (work) => work({ testSession: true });
	const first = await applyPlan({
		collections,
		appliedAt: APPLY_AT,
		runTransaction: transaction,
	});
	assert.equal(first.changed, 4);
	const jobWrites = collections.jobs.updateOneCalls;
	const auditWrites = collections.audits.updateOneCalls;
	const second = await applyPlan({
		collections,
		appliedAt: new Date(APPLY_AT.getTime() + 60_000),
		runTransaction: transaction,
	});
	assert.equal(second.changed, 0);
	assert.equal(collections.jobs.updateOneCalls, jobWrites);
	assert.equal(collections.audits.updateOneCalls, auditWrites);
	assert.ok(
		second.plan.targets.every(
			(entry) => entry.state === "reopened_waiting_mapping"
		)
	);
});

test("transaction retries do not overcount changed target pairs", async () => {
	const fixture = fixtureCollections();
	const { collections } = fixture;
	const applied = await applyPlan({
		collections,
		appliedAt: APPLY_AT,
		runTransaction: async (work) => {
			await work({ retryAttempt: 1 });
			const reset = fixtureCollections().collections;
			for (const role of ["events", "mirrors", "jobs", "audits"]) {
				collections[role].documents = reset[role].documents;
			}
			return work({ retryAttempt: 2 });
		},
	});
	assert.equal(applied.changed, 4);
	assert.ok(
		applied.plan.targets.every(
			(entry) => entry.state === "reopened_waiting_mapping"
		)
	);
});

test("reads sharing a transaction session are sequential", async () => {
	const { collections } = fixtureCollections();
	let active = 0;
	let maximumActive = 0;
	for (const role of ["events", "mirrors", "jobs", "audits"]) {
		const original = collections[role].findOne.bind(collections[role]);
		collections[role].findOne = async (...arguments_) => {
			active += 1;
			maximumActive = Math.max(maximumActive, active);
			await Promise.resolve();
			const result = await original(...arguments_);
			active -= 1;
			return result;
		};
	}
	await loadScopes(collections, { transactionSession: true });
	assert.equal(maximumActive, 1);
});

test("postcondition mode accepts projection transition and final API convergence", async () => {
	const { collections } = fixtureCollections();
	await applyPlan({
		collections,
		appliedAt: APPLY_AT,
		runTransaction: async (work) => work({ testSession: true }),
	});
	for (const target of TARGETS) {
		const event = collections.events.documents.get(target.eventId);
		event.status = "pending";
		event.attempts = 0;
		event.nextAttemptAt = new Date(APPLY_AT.getTime() + 1_000);
		event.errorCode = "";
		event.errorMessage = "";
		delete event.leaseOwner;
		delete event.leaseAcquiredAt;
		delete event.leaseUntil;
	}
	let plan = buildPlan(await loadScopes(collections), APPLY_AT);
	assert.ok(
		plan.targets.every((entry) => entry.state === "requeued_waiting_projection")
	);
	assertPostconditions(plan);

	const reservationId = oid("6a79ffff0000000000000001");
	for (const target of TARGETS) {
		const event = collections.events.documents.get(target.eventId);
		const mirror = collections.mirrors.documents.get(target.mirrorId);
		event.status = "completed";
		event.errorCode = "";
		event.reservationMongoId = reservationId;
		mirror.projectionStatus = "created";
		mirror.lastErrorCode = "";
		mirror.reservationMongoId = reservationId;
	}
	plan = buildPlan(await loadScopes(collections), APPLY_AT);
	assert.ok(
		plan.targets.every((entry) => entry.state === "projected_waiting_fallback")
	);
	assertPostconditions(plan);

	for (const target of TARGETS) {
		const job = collections.jobs.documents.get(target.jobId);
		const audit = collections.audits.documents.get(target.auditId);
		job.status = "completed_api";
		job.reservationMongoId = reservationId;
		job.hotelRunnerEventId = oid(target.eventId);
		job.hotelRunnerMirrorId = oid(target.mirrorId);
		audit.processingStatus = "created";
		audit.hasReservationConnection = true;
		audit.reservationMongoId = reservationId;
		audit.hotelRunnerFirstFallback.status = "completed_api";
	}
	plan = buildPlan(await loadScopes(collections), APPLY_AT);
	assert.ok(plan.targets.every((entry) => entry.state === "converged"));
	assertPostconditions(plan);
});

test("compare-and-set miss aborts instead of widening scope", async () => {
	const { collections } = fixtureCollections();
	collections.jobs.updateOne = async () => ({
		matchedCount: 0,
		modifiedCount: 0,
	});
	await assert.rejects(
		applyPlan({
			collections,
			appliedAt: APPLY_AT,
			runTransaction: async (work) => work({ testSession: true }),
		}),
		(error) => error.code === "HOTELRUNNER_STALE_MAPPING_RECOVERY_JOB_CAS_LOST"
	);
});

test("standalone primary applies all audits before any job and is idempotent", async () => {
	const order = [];
	const hook = async ({ collection, replacement, phase }) => {
		if (phase === "before") {
			order.push(`${collection.role}:${id(replacement._id)}`);
		}
	};
	const { collections } = fixtureCollections({
		audits: { onReplace: hook },
		jobs: { onReplace: hook },
	});
	const result = await applyPlanStandalone({
		collections,
		appliedAt: APPLY_AT,
		serialRunId: RUN_ID,
		clock: () => APPLY_AT,
	});
	assert.equal(result.changed, 4);
	assert.equal(result.acknowledgementsRecovered, 0);
	assert.deepEqual(
		order.map((entry) => entry.split(":")[0]),
		["audits", "audits", "audits", "audits", "jobs", "jobs", "jobs", "jobs"]
	);
	assert.ok(
		result.plan.targets.every(
			(entry) => entry.state === "reopened_waiting_mapping"
		)
	);
	assert.equal(collections.events.replaceOneCalls, 0);
	assert.equal(collections.mirrors.replaceOneCalls, 0);

	const writes = order.length;
	const rerun = await applyPlanStandalone({
		collections,
		appliedAt: new Date(APPLY_AT.getTime() + 1_000),
		serialRunId: "b".repeat(32),
		clock: () => new Date(APPLY_AT.getTime() + 1_000),
	});
	assert.equal(rerun.changed, 0);
	assert.equal(order.length, writes);
});

test("topology strategy requires a positive writable hello", async () => {
	assert.equal(
		await resolveApplyStrategy({
			command: async () => ({ ok: 1, isWritablePrimary: true }),
		}),
		STANDALONE_APPLY_STRATEGY
	);
	assert.equal(
		await resolveApplyStrategy({
			command: async () => ({
				ok: 1,
				isWritablePrimary: true,
				setName: "rs0",
			}),
		}),
		"snapshot_transaction"
	);
	await assert.rejects(
		resolveApplyStrategy({
			command: async () => ({ ok: 1, isWritablePrimary: false }),
		}),
		(error) =>
			error.code === "HOTELRUNNER_STALE_MAPPING_RECOVERY_PRIMARY_REQUIRED"
	);
	await assert.rejects(
		resolveApplyStrategy({
			command: async () => ({ isWritablePrimary: true }),
		}),
		(error) =>
			error.code === "HOTELRUNNER_STALE_MAPPING_RECOVERY_TOPOLOGY_UNKNOWN"
	);
	await assert.rejects(
		resolveApplyStrategy({
			command: async () => ({
				ok: 1,
				isWritablePrimary: true,
				hosts: ["unexpected-replica:27017"],
			}),
		}),
		(error) =>
			error.code === "HOTELRUNNER_STALE_MAPPING_RECOVERY_TOPOLOGY_UNKNOWN"
	);
	let calls = 0;
	assert.equal(
		await resolveApplyStrategy({
			command: async (command) => {
				calls += 1;
				if (command.hello) {
					const error = new Error("no hello");
					error.code = 59;
					throw error;
				}
				return { ok: 1, ismaster: true };
			},
		}),
		STANDALONE_APPLY_STRATEGY
	);
	assert.equal(calls, 2);
});

test("full-document CAS distinguishes a missing null from a swapped extra key", () => {
	const original = { _id: oid(TARGETS[0].jobId), nullable: null, stable: 1 };
	const filter = buildFullDocumentCasFilter(original);
	const literal = Object.fromEntries(
		filter.$expr.$eq[1].$literal.map(({ k, v }) => [k, v])
	);
	const drifted = { _id: original._id, replacement: "extra", stable: 1 };
	assert.equal(canonicalEjsonSha256(literal), canonicalEjsonSha256(original));
	assert.notEqual(canonicalEjsonSha256(literal), canonicalEjsonSha256(drifted));
});

test("standalone compensates exactly after a clean failure at each of eight writes", async () => {
	for (let failAt = 1; failAt <= 8; failAt += 1) {
		let forwardWrites = 0;
		let failed = false;
		const hook = async ({ collection, replacement, phase }) => {
			if (phase !== "before" || !isForwardReplacement(collection, replacement))
				return;
			forwardWrites += 1;
			if (!failed && forwardWrites === failAt) {
				failed = true;
				throw new Error(`fail forward write ${failAt}`);
			}
		};
		const { collections } = fixtureCollections({
			audits: { onReplace: hook },
			jobs: { onReplace: hook },
		});
		const original = exactCollectionHashes(collections);
		await assert.rejects(
			applyPlanStandalone({
				collections,
				appliedAt: APPLY_AT,
				serialRunId: RUN_ID,
				clock: () => APPLY_AT,
			}),
			(error) => error.code === "HOTELRUNNER_STALE_MAPPING_RECOVERY_COMPENSATED"
		);
		assert.deepEqual(
			exactCollectionHashes(collections),
			original,
			`write ${failAt}`
		);
	}
});

test("lost acknowledgement at each standalone write is recovered without retry", async () => {
	for (let loseAt = 1; loseAt <= 8; loseAt += 1) {
		let forwardWrites = 0;
		let lost = false;
		const hook = async ({ collection, replacement, phase }) => {
			if (phase !== "after" || !isForwardReplacement(collection, replacement))
				return;
			forwardWrites += 1;
			if (!lost && forwardWrites === loseAt) {
				lost = true;
				throw new Error(`lost acknowledgement ${loseAt}`);
			}
		};
		const { collections } = fixtureCollections({
			audits: { onReplace: hook },
			jobs: { onReplace: hook },
		});
		const result = await applyPlanStandalone({
			collections,
			appliedAt: APPLY_AT,
			serialRunId: RUN_ID,
			clock: () => APPLY_AT,
		});
		assert.equal(result.changed, 4);
		assert.equal(result.acknowledgementsRecovered, 1);
		assert.equal(collections.audits.replaceOneCalls, 4);
		assert.equal(collections.jobs.replaceOneCalls, 4);
	}
});

test("compensation failure leaves the audit open whenever its job remains active", async () => {
	let forwardWrites = 0;
	let forwardFailed = false;
	let compensationFailed = false;
	const hook = async ({ collection, replacement, phase }) => {
		if (phase !== "before") return;
		if (isForwardReplacement(collection, replacement)) {
			forwardWrites += 1;
			if (!forwardFailed && forwardWrites === 6) {
				forwardFailed = true;
				throw new Error("fail second job");
			}
			return;
		}
		if (
			forwardFailed &&
			!compensationFailed &&
			collection.role === "jobs" &&
			replacement.status === "needs_review"
		) {
			compensationFailed = true;
			throw new Error("fail job compensation");
		}
	};
	const { collections } = fixtureCollections({
		audits: { onReplace: hook },
		jobs: { onReplace: hook },
	});
	await assert.rejects(
		applyPlanStandalone({
			collections,
			appliedAt: APPLY_AT,
			serialRunId: RUN_ID,
			clock: () => APPLY_AT,
		}),
		(error) =>
			error.code === "HOTELRUNNER_STALE_MAPPING_RECOVERY_COMPENSATION_FAILED"
	);
	const first = TARGETS[0];
	assert.equal(
		collections.jobs.documents.get(first.jobId).status,
		"awaiting_hotelrunner"
	);
	assert.equal(
		collections.audits.documents.get(first.auditId).processingStatus,
		"awaiting_hotelrunner"
	);
});

test("third-state drift is never overwritten during compensation", async () => {
	let forwardWrites = 0;
	let drifted = false;
	const hook = async ({ collection, replacement, phase }) => {
		if (phase !== "before" || !isForwardReplacement(collection, replacement))
			return;
		forwardWrites += 1;
		if (!drifted && forwardWrites === 6) {
			drifted = true;
			collections.audits.documents.get(
				TARGETS[0].auditId
			).foreignConcurrent = true;
			throw new Error("fail after concurrent audit drift");
		}
	};
	const { collections } = fixtureCollections({
		audits: { onReplace: hook },
		jobs: { onReplace: hook },
	});
	await assert.rejects(
		applyPlanStandalone({
			collections,
			appliedAt: APPLY_AT,
			serialRunId: RUN_ID,
			clock: () => APPLY_AT,
		}),
		(error) =>
			error.code ===
			"HOTELRUNNER_STALE_MAPPING_RECOVERY_MANUAL_INTERVENTION_REQUIRED"
	);
	assert.equal(
		collections.audits.documents.get(TARGETS[0].auditId).foreignConcurrent,
		true
	);
	assert.equal(
		collections.jobs.documents.get(TARGETS[0].jobId).status,
		"needs_review"
	);
});

test("a killed audit phase is held by its lease then resumed exactly after expiry", async () => {
	const { collections } = fixtureCollections();
	simulateKilledAfterAuditPhase(collections);
	await assert.rejects(
		applyPlanStandalone({
			collections,
			appliedAt: new Date(APPLY_AT.getTime() + 1_000),
			serialRunId: "b".repeat(32),
			clock: () => new Date(APPLY_AT.getTime() + 1_000),
		}),
		(error) => error.code === "HOTELRUNNER_STALE_MAPPING_RECOVERY_LOCK_HELD"
	);
	const resumedAt = new Date(LEASE_UNTIL.getTime() + 1);
	const resumed = await applyPlanStandalone({
		collections,
		appliedAt: resumedAt,
		serialRunId: "c".repeat(32),
		clock: () => resumedAt,
	});
	assert.equal(resumed.changed, 4);
	assert.ok(
		resumed.plan.targets.every(
			(entry) => entry.state === "reopened_waiting_mapping"
		)
	);
});

test("a concurrent loser observes the active lease and never compensates the winner", async () => {
	let releaseFirst;
	let firstWrittenResolve;
	const firstWritten = new Promise((resolve) => {
		firstWrittenResolve = resolve;
	});
	const release = new Promise((resolve) => {
		releaseFirst = resolve;
	});
	let paused = false;
	const hook = async ({ collection, replacement, phase }) => {
		if (
			!paused &&
			phase === "after" &&
			collection.role === "audits" &&
			id(replacement._id) === TARGETS[0].auditId
		) {
			paused = true;
			firstWrittenResolve();
			await release;
		}
	};
	const { collections } = fixtureCollections({ audits: { onReplace: hook } });
	const winner = applyPlanStandalone({
		collections,
		appliedAt: APPLY_AT,
		serialRunId: RUN_ID,
		clock: () => APPLY_AT,
	});
	await firstWritten;
	await assert.rejects(
		applyPlanStandalone({
			collections,
			appliedAt: new Date(APPLY_AT.getTime() + 1_000),
			serialRunId: "d".repeat(32),
			clock: () => new Date(APPLY_AT.getTime() + 1_000),
		}),
		(error) => error.code === "HOTELRUNNER_STALE_MAPPING_RECOVERY_LOCK_HELD"
	);
	releaseFirst();
	const completed = await winner;
	assert.equal(completed.changed, 4);
});

test("full BSON snapshots preserve exotic types and unknown fields", async () => {
	const { collections } = fixtureCollections();
	const job = collections.jobs.documents.get(TARGETS[0].jobId);
	job.unknownBson = {
		decimal: BSON.Decimal128.fromString("123.4500"),
		binary: new BSON.Binary(Buffer.from([0, 1, 2, 255])),
		long: BSON.Long.fromString("9223372036854775806"),
		date: new Date("2026-08-10T15:59:59.999Z"),
		objectId: oid("6a79ffff0000000000000002"),
	};
	const expectedHash = canonicalEjsonSha256(job.unknownBson);
	await applyPlanStandalone({
		collections,
		appliedAt: APPLY_AT,
		serialRunId: RUN_ID,
		clock: () => APPLY_AT,
	});
	assert.equal(
		canonicalEjsonSha256(
			collections.jobs.documents.get(TARGETS[0].jobId).unknownBson
		),
		expectedHash
	);
});

test("mixed killed-run recovery images fail closed", async () => {
	const { collections } = fixtureCollections();
	simulateKilledAfterAuditPhase(collections);
	const second = collections.audits.documents.get(TARGETS[1].auditId);
	second.hotelRunnerFirstFallback.serialRunId = "e".repeat(32);
	second.hotelRunnerFirstFallback.recoveryHistory[0].serialRunId = "e".repeat(
		32
	);
	await assert.rejects(
		applyPlanStandalone({
			collections,
			appliedAt: new Date(LEASE_UNTIL.getTime() + 1),
			serialRunId: "f".repeat(32),
			clock: () => new Date(LEASE_UNTIL.getTime() + 1),
		}),
		(error) => error.code === "HOTELRUNNER_STALE_MAPPING_RECOVERY_MIXED_IMAGES"
	);
});
