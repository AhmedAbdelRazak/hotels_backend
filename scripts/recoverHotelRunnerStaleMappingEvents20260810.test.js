/** @format */

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const mongoose = require("mongoose");

const {
	AWAITING_MESSAGE,
	RECOVERY_HOLD_MS,
	RECOVERY_ID,
	REOPEN_DECISION,
	STALE_MAPPING_CODE,
	TARGETS,
	TERMINAL_CODE,
	TERMINAL_DECISION,
	TERMINAL_MESSAGE,
	applyPlan,
	assertPostconditions,
	buildAuditReopenUpdate,
	buildJobReopenUpdate,
	buildPlan,
	buildTerminalAuditFilter,
	buildTerminalJobFilter,
	classifyScope,
	loadScopes,
	parseArguments,
} = require("./recoverHotelRunnerStaleMappingEvents20260810");

const APPLY_AT = new Date("2026-08-10T16:00:00.000Z");

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
	constructor(documents) {
		this.documents = new Map(
			documents.map((document) => [id(document._id), document])
		);
		this.findOneCalls = 0;
		this.updateOneCalls = 0;
	}

	async findOne(filter) {
		this.findOneCalls += 1;
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
}

function fixtureCollections() {
	const scopes = TARGETS.map(terminalScope);
	return {
		scopes,
		collections: {
			events: new FakeCollection(scopes.map((scope) => scope.event)),
			mirrors: new FakeCollection(scopes.map((scope) => scope.mirror)),
			jobs: new FakeCollection(scopes.map((scope) => scope.job)),
			audits: new FakeCollection(scopes.map((scope) => scope.audit)),
		},
	};
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
	const jobUpdate = buildJobReopenUpdate(APPLY_AT);
	const auditUpdate = buildAuditReopenUpdate(target, APPLY_AT, scope);
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
