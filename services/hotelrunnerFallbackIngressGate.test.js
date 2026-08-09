/** @format */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const HotelRunnerOtaFallbackJob = require("../models/hotelrunner_ota_fallback_job");
const {
	createHotelRunnerFallbackIngressGate,
	validateHotelRunnerFallbackCreationAuthorization,
} = require("./hotelrunnerFallbackIngressGate");

const JOB_ID = "6a789cf2f77fb5bdaf73b0b3";
const EMAIL_ID = "6a789cb5f77fb5bdaf73b0b1";
const HOTEL_ID = "6a40b6a1a6efe70450536038";
const RESERVATION_ID = "6a789cea66c058f4ab621ebf";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);
const HASH_F = "f".repeat(64);

const clone = (value) => {
	if (value == null || typeof value !== "object") return value;
	if (value instanceof Date) return new Date(value);
	if (Array.isArray(value)) return value.map(clone);
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [key, clone(item)])
	);
};

function mutableClock(initial = "2026-08-09T18:00:00.000Z") {
	let current = new Date(initial);
	return {
		now: () => new Date(current),
		advance(ms) {
			current = new Date(current.getTime() + ms);
		},
	};
}

function fallbackJob(overrides = {}) {
	return {
		_id: JOB_ID,
		hotelId: HOTEL_ID,
		provider: "agoda",
		confirmationNumber: "2039878308",
		identityKey: "agoda:2039878308",
		status: "processing",
		leaseOwner: "worker-a",
		leaseToken: "lease-token-a",
		leaseUntil: new Date("2026-08-09T18:05:00.000Z"),
		archiveFingerprint: HASH_A,
		inboundEmailId: EMAIL_ID,
		inboundEmailHash: HASH_B,
		normalizedReservationHash: HASH_C,
		resolvedHotelProofHash: HASH_D,
		hrIdFingerprint: HASH_E,
		lookupConfirmationHash: HASH_F,
		negativeLookupProof: {
			status: "confirmed_empty",
			proofId: "proof-1",
			hotelId: HOTEL_ID,
			hrIdFingerprint: HASH_E,
			provider: "agoda",
			confirmationNumber: "2039878308",
			lookupConfirmationHash: HASH_F,
			archiveFingerprint: HASH_A,
			resolvedHotelProofHash: HASH_D,
			responseHash: HASH_A,
			resultCount: 0,
			checkedAt: new Date("2026-08-09T17:59:55.000Z"),
			expiresAt: new Date("2026-08-09T18:02:00.000Z"),
		},
		ingressDecision: { status: "open", apiObservationCount: 0 },
		...overrides,
	};
}

function boundaryFromJob(job) {
	return {
		mode: "confirmed_empty_email_fallback",
		fallbackJobId: String(job._id),
		hotelId: String(job.hotelId),
		provider: job.provider,
		confirmationNumber: job.confirmationNumber,
		identityKey: job.identityKey,
		archiveFingerprint: job.archiveFingerprint,
		inboundEmailId: String(job.inboundEmailId),
		inboundEmailHash: job.inboundEmailHash,
		normalizedReservationHash: job.normalizedReservationHash,
		resolvedHotelProofHash: job.resolvedHotelProofHash,
		hrIdFingerprint: job.hrIdFingerprint,
		lookupConfirmationHash: job.lookupConfirmationHash,
		confirmedEmptyProof: clone(job.negativeLookupProof),
		jobLeaseOwner: job.leaseOwner,
		jobLeaseToken: job.leaseToken,
		jobLeaseUntil: new Date(job.leaseUntil),
	};
}

function createMemoryStore(initialJob) {
	const state = clone(initialJob);
	const reservations = [];
	const sameIdentity = (value) =>
		String(value.hotelId) === String(state.hotelId) &&
		value.provider === state.provider &&
		value.confirmationNumber === state.confirmationNumber;
	return {
		state,
		reservations,
		async markOpenApi(observation) {
			if (!sameIdentity(observation) || state.ingressDecision.status !== "open") {
				return null;
			}
			Object.assign(state.ingressDecision, {
				status: "api_observed",
				apiObservationKey: observation.observationKey,
				apiObservedAt: new Date(observation.observedAt),
				apiLastObservedAt: new Date(observation.observedAt),
				apiObservationCount:
					Number(state.ingressDecision.apiObservationCount || 0) + 1,
			});
			return clone(state);
		},
		async touchApiObserved(_job, observation) {
			if (state.ingressDecision.status !== "api_observed") return null;
			state.ingressDecision.apiLastObservedAt = new Date(observation.observedAt);
			state.ingressDecision.apiObservationCount += 1;
			return clone(state);
		},
		async findIdentity(identity) {
			return sameIdentity(identity) ? clone(state) : null;
		},
		async findJob(jobId) {
			return String(jobId) === String(state._id) ? clone(state) : null;
		},
		async authorizeOpen(normalized, authorization) {
			if (
				state.ingressDecision.status !== "open" ||
				state.status !== "processing" ||
				state.leaseOwner !== normalized.jobLeaseOwner ||
				state.leaseToken !== normalized.jobLeaseToken ||
				state.negativeLookupProof.proofId !== normalized.proof.proofId
			) {
				return null;
			}
			state.ingressDecision.status = "email_authorized";
			state.ingressDecision.emailAuthorization = clone(authorization);
			state.ingressDecision.emailAuthorizationLeaseUntil = new Date(
				authorization.leaseUntil
			);
			return clone(state);
		},
		async releaseAuthorization(_job, authorization) {
			if (
				state.ingressDecision.status !== "email_authorized" ||
				state.ingressDecision.emailAuthorization?.token !== authorization.token
			) {
				return null;
			}
			state.ingressDecision = {
				...state.ingressDecision,
				status: "open",
				emailAuthorization: undefined,
				emailAuthorizationLeaseUntil: undefined,
			};
			return clone(state);
		},
		async expireAuthorizationToApi(_job, authorization, observation) {
			const lease = state.ingressDecision.emailAuthorizationLeaseUntil;
			if (
				state.ingressDecision.status !== "email_authorized" ||
				state.ingressDecision.emailAuthorization?.token !== authorization.token ||
				lease.getTime() > observation.observedAt.getTime()
			) {
				return null;
			}
			state.ingressDecision = {
				status: "api_observed",
				apiObservationKey: observation.observationKey,
				apiObservedAt: new Date(observation.observedAt),
				apiLastObservedAt: new Date(observation.observedAt),
				apiObservationCount:
					Number(state.ingressDecision.apiObservationCount || 0) + 1,
			};
			return clone(state);
		},
		async expireAuthorizationToOpen(_job, authorization, at) {
			const lease = state.ingressDecision.emailAuthorizationLeaseUntil;
			if (
				state.ingressDecision.status !== "email_authorized" ||
				state.ingressDecision.emailAuthorization?.token !== authorization.token ||
				lease.getTime() > at.getTime()
			) {
				return null;
			}
			state.ingressDecision.status = "open";
			delete state.ingressDecision.emailAuthorization;
			delete state.ingressDecision.emailAuthorizationLeaseUntil;
			return clone(state);
		},
		async commitAuthorization(_job, authorization, reservationId, committedAt) {
			if (
				state.ingressDecision.status !== "email_authorized" ||
				state.ingressDecision.emailAuthorization?.token !== authorization.token
			) {
				return null;
			}
			state.ingressDecision.status = "email_committed";
			state.ingressDecision.emailReservationId = reservationId;
			state.ingressDecision.emailCommittedAt = new Date(committedAt);
			delete state.ingressDecision.emailAuthorizationLeaseUntil;
			return clone(state);
		},
		async findReservationByAuthorization(_job, authorization, reservationId = "") {
			return (
				reservations.find(
					(item) =>
						(!reservationId || String(item._id) === String(reservationId)) &&
						item.supplierData.hotelRunnerFirstFallbackCreation
							.creationAuthorization.token === authorization.token &&
						item.supplierData.hotelRunnerFirstFallbackCreation
							.creationAuthorization.bindingHash === authorization.bindingHash
				) || null
			);
		},
	};
}

const observation = (at = "2026-08-09T18:00:00.000Z") => ({
	hotelId: HOTEL_ID,
	provider: "agodaycs5",
	confirmationNumber: "2039878308",
	observationKey: HASH_E,
	payloadHash: HASH_F,
	source: "push",
	observedAt: new Date(at),
});

test("fallback job schema stores one durable ingress linearization decision", () => {
	assert.ok(HotelRunnerOtaFallbackJob.schema.path("ingressDecision.status"));
	assert.ok(
		HotelRunnerOtaFallbackJob.schema.path(
			"ingressDecision.emailAuthorizationLeaseUntil"
		)
	);
	assert.ok(
		HotelRunnerOtaFallbackJob.schema.path("ingressDecision.emailReservationId")
	);
});

test("callback marker wins the adversarial pause before email authorization", async () => {
	const clock = mutableClock();
	const store = createMemoryStore(fallbackJob());
	const gate = createHotelRunnerFallbackIngressGate({
		dependencies: { store, clock: clock.now, randomToken: () => HASH_B },
	});

	const api = await gate.markApiObserved(observation());
	assert.equal(api.decision, "api_observed");
	await assert.rejects(
		gate.authorizeEmailCreation({ boundary: boundaryFromJob(store.state) }),
		(error) =>
			error?.code === "HOTELRUNNER_FALLBACK_API_OBSERVED_BEFORE_EMAIL" &&
			error.retryable === true
	);
	assert.equal(store.state.ingressDecision.status, "api_observed");
});

test("active email commit lease rejects callback ACK and release lets callback win", async () => {
	const clock = mutableClock();
	const store = createMemoryStore(fallbackJob());
	const gate = createHotelRunnerFallbackIngressGate({
		dependencies: { store, clock: clock.now, randomToken: () => HASH_B },
	});
	const boundary = boundaryFromJob(store.state);
	const authorization = await gate.authorizeEmailCreation({ boundary });
	assert.equal(
		validateHotelRunnerFallbackCreationAuthorization(
			authorization,
			boundary,
			{ requireActiveLease: true, at: clock.now() }
		),
		true
	);
	assert.equal(
		validateHotelRunnerFallbackCreationAuthorization(
			{ ...authorization, guestEmail: "must-not-persist@example.com" },
			boundary
		),
		false
	);
	await assert.rejects(
		gate.markApiObserved(observation()),
		(error) =>
			error?.code === "HOTELRUNNER_FALLBACK_EMAIL_COMMIT_IN_PROGRESS" &&
			error.retryable === true
	);

	const released = await gate.releaseEmailCreation({ boundary, authorization });
	assert.equal(released.released, true);
	const api = await gate.markApiObserved(observation());
	assert.equal(api.decision, "api_observed");
});

test("email exclusion lasts for the full owned job lease, not a shorter timer", async () => {
	const clock = mutableClock();
	const store = createMemoryStore(fallbackJob());
	const gate = createHotelRunnerFallbackIngressGate({
		dependencies: { store, clock: clock.now, randomToken: () => HASH_B },
	});
	const boundary = boundaryFromJob(store.state);
	const authorization = await gate.authorizeEmailCreation({ boundary });
	assert.equal(
		new Date(authorization.leaseUntil).toISOString(),
		store.state.leaseUntil.toISOString()
	);

	clock.advance(2 * 60_000 + 1);
	await assert.rejects(
		gate.markApiObserved(observation(clock.now().toISOString())),
		(error) =>
			error?.code === "HOTELRUNNER_FALLBACK_EMAIL_COMMIT_IN_PROGRESS"
	);
	assert.equal(store.state.ingressDecision.status, "email_authorized");
});

test("expired email authorization recovers committed reservation before callback ordering", async () => {
	const clock = mutableClock();
	const store = createMemoryStore(fallbackJob());
	const gate = createHotelRunnerFallbackIngressGate({
		dependencies: { store, clock: clock.now, randomToken: () => HASH_B },
	});
	const boundary = boundaryFromJob(store.state);
	const authorization = await gate.authorizeEmailCreation({ boundary });
	store.reservations.push({
		_id: RESERVATION_ID,
		hotelId: HOTEL_ID,
		supplierData: {
			hotelRunnerFirstFallbackCreation: {
				fallbackJobId: JOB_ID,
				hotelId: HOTEL_ID,
				archiveFingerprint: HASH_A,
				confirmedEmptyProof: clone(authorization.proof),
				creationAuthorization: clone(authorization),
			},
		},
	});
	clock.advance(5 * 60_000 + 1);

	const api = await gate.markApiObserved(
		observation(clock.now().toISOString())
	);
	assert.equal(api.decision, "email_committed");
	assert.equal(store.state.ingressDecision.status, "email_committed");
	assert.equal(
		String(store.state.ingressDecision.emailReservationId),
		RESERVATION_ID
	);
});

test("callback cannot preempt an expired authorization without coordinator recovery", async () => {
	const clock = mutableClock();
	const store = createMemoryStore(fallbackJob());
	const gate = createHotelRunnerFallbackIngressGate({
		dependencies: { store, clock: clock.now, randomToken: () => HASH_B },
	});
	const boundary = boundaryFromJob(store.state);
	await gate.authorizeEmailCreation({ boundary });
	clock.advance(5 * 60_000 + 1);

	await assert.rejects(
		gate.markApiObserved(observation(clock.now().toISOString())),
		(error) =>
			error?.code ===
				"HOTELRUNNER_FALLBACK_EMAIL_COMMIT_RECOVERY_REQUIRED" &&
			error.retryable === true
	);
	assert.equal(store.state.ingressDecision.status, "email_authorized");
	assert.equal(store.state.ingressDecision.apiObservationCount, 0);
});

test("email commit and acknowledgement-loss release adopt only exact token-stamped reservation", async () => {
	const clock = mutableClock();
	const store = createMemoryStore(fallbackJob());
	const gate = createHotelRunnerFallbackIngressGate({
		dependencies: { store, clock: clock.now, randomToken: () => HASH_B },
	});
	const boundary = boundaryFromJob(store.state);
	const authorization = await gate.authorizeEmailCreation({ boundary });
	store.reservations.push({
		_id: RESERVATION_ID,
		hotelId: HOTEL_ID,
		supplierData: {
			hotelRunnerFirstFallbackCreation: {
				fallbackJobId: JOB_ID,
				hotelId: HOTEL_ID,
				archiveFingerprint: HASH_A,
				confirmedEmptyProof: clone(authorization.proof),
				creationAuthorization: clone(authorization),
			},
		},
	});

	const recovered = await gate.releaseEmailCreation({ boundary, authorization });
	assert.equal(recovered.committed, true);
	assert.equal(recovered.released, false);
	assert.equal(store.state.ingressDecision.status, "email_committed");
});

test("authorization proof tampering fails commit and release validation in every mode", async () => {
	const clock = mutableClock();
	const store = createMemoryStore(fallbackJob());
	const gate = createHotelRunnerFallbackIngressGate({
		dependencies: { store, clock: clock.now, randomToken: () => HASH_B },
	});
	const boundary = boundaryFromJob(store.state);
	const authorization = await gate.authorizeEmailCreation({ boundary });
	for (const tamperedProof of [
		{ ...authorization.proof, proofId: "proof-tampered" },
		{ ...authorization.proof, responseHash: HASH_C },
		{
			...authorization.proof,
			checkedAt: "2026-08-09T17:59:54.000Z",
		},
		{
			...authorization.proof,
			expiresAt: "2026-08-09T18:02:01.000Z",
		},
	]) {
		const tampered = { ...authorization, proof: tamperedProof };
		assert.equal(
			validateHotelRunnerFallbackCreationAuthorization(tampered, boundary),
			false
		);
		assert.equal(
			validateHotelRunnerFallbackCreationAuthorization(tampered, boundary, {
				requireActiveLease: true,
				at: clock.now(),
			}),
			false
		);
	}

	const tampered = {
		...authorization,
		proof: { ...authorization.proof, responseHash: HASH_C },
	};
	await assert.rejects(
		gate.commitEmailCreation({
			boundary,
			authorization: tampered,
			reservationId: RESERVATION_ID,
		}),
		(error) => error?.code === "HOTELRUNNER_FALLBACK_EMAIL_COMMIT_AUTH_INVALID"
	);
	await assert.rejects(
		gate.releaseEmailCreation({ boundary, authorization: tampered }),
		(error) => error?.code === "HOTELRUNNER_FALLBACK_EMAIL_RELEASE_AUTH_INVALID"
	);
});

test("callback recovery rejects a token-matching but tampered full reservation marker", async () => {
	const clock = mutableClock();
	const store = createMemoryStore(fallbackJob());
	const gate = createHotelRunnerFallbackIngressGate({
		dependencies: { store, clock: clock.now, randomToken: () => HASH_B },
	});
	const boundary = boundaryFromJob(store.state);
	const authorization = await gate.authorizeEmailCreation({ boundary });
	store.reservations.push({
		_id: RESERVATION_ID,
		hotelId: HOTEL_ID,
		supplierData: {
			hotelRunnerFirstFallbackCreation: {
				fallbackJobId: JOB_ID,
				hotelId: HOTEL_ID,
				archiveFingerprint: HASH_A,
				confirmedEmptyProof: clone(authorization.proof),
				creationAuthorization: {
					...clone(authorization),
					proof: {
						...clone(authorization.proof),
						responseHash: HASH_C,
					},
				},
			},
		},
	});

	await assert.rejects(
		gate.releaseEmailCreation({ boundary, authorization }),
		(error) =>
			error?.code === "HOTELRUNNER_FALLBACK_AUTHORIZATION_MARKER_INVALID" &&
			error.retryable === true
	);
	assert.equal(store.state.ingressDecision.status, "email_authorized");
});
