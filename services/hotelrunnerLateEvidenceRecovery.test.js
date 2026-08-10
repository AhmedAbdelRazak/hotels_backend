/** @format */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
	DEFAULT_LATE_EVIDENCE_SCAN_LIMIT,
	LATE_EVIDENCE_WAITING_ERROR,
	createHotelRunnerLateEvidenceRecovery,
} = require("./hotelrunnerLateEvidenceRecovery");

const HOTEL_ID = "64b000000000000000000001";
const EVIDENCE_HASH_A = "a".repeat(64);
const EVIDENCE_HASH_B = "b".repeat(64);
const CUTOFF = new Date("2026-08-07T01:59:00.000Z");
const NOW = new Date("2026-08-10T16:30:00.000Z");

function eventFixture(overrides = {}) {
	return {
		_id: "6a7000000000000000000001",
		hotelId: HOTEL_ID,
		status: "failed",
		errorCode: LATE_EVIDENCE_WAITING_ERROR,
		payloadHash: "c".repeat(64),
		canonicalHash: "d".repeat(64),
		attempts: 8,
		processedAt: new Date("2026-08-10T16:00:00.000Z"),
		updatedAt: new Date("2026-08-10T16:00:00.000Z"),
		integrityReason: "",
		integrityConflict: false,
		leaseOwner: "",
		leaseUntil: null,
		result: {},
		payload: { channel: "synthetic" },
		...overrides,
	};
}

function normalizedFixture() {
	return {
		hotelRunnerReservationId: "hr-synthetic-1",
		providerNumber: "provider-synthetic-1",
		channel: "synthetic",
		state: "confirmed",
		currency: "USD",
		checkinDate: "2026-08-11",
		checkoutDate: "2026-08-12",
		rooms: [{ invCode: "room-synthetic-1" }],
	};
}

function fakeEventModel(
	events,
	{ modifiedCount = 1, candidateExists = events.length > 0 } = {}
) {
	const captured = { exists: [], find: [], updates: [], limits: [] };
	return {
		captured,
		model: {
			exists(filter) {
				captured.exists.push(filter);
				return {
					exec: async () =>
						candidateExists ? { _id: events[0]?._id || "candidate" } : null,
				};
			},
			find(filter) {
				captured.find.push(filter);
				let limit = events.length;
				const query = {
					sort() {
						return query;
					},
					limit(value) {
						limit = value;
						captured.limits.push(value);
						return query;
					},
					select() {
						return query;
					},
					lean() {
						return query;
					},
					exec: async () => events.slice(0, limit),
				};
				return query;
			},
			updateOne(filter, update) {
				captured.updates.push({ filter, update });
				return { exec: async () => ({ modifiedCount }) };
			},
		},
	};
}

function createRecovery({ events, modelOptions, dependencies = {} }) {
	const fake = fakeEventModel(events, modelOptions);
	let normalizedCount = 0;
	const recovery = createHotelRunnerLateEvidenceRecovery({
		config: {
			configured: true,
			projectionEnabled: true,
			hotelId: HOTEL_ID,
			projectionNotBefore: CUTOFF,
		},
		normalizeEvent(event) {
			normalizedCount += 1;
			assert.ok(event.payload);
			return normalizedFixture();
		},
		dependencies: {
			EventModel: fake.model,
			ReservationModel: {},
			loadConfiguredHotel: async () => ({ _id: HOTEL_ID, currency: "SAR" }),
			hotelRunnerCommercialProvider: () => "synthetic",
			loadQueuedEmailCommercialBridge: async () => ({
				ok: false,
				reason: "fallback_job_not_found",
			}),
			findLinkedReservation: async () => ({ reservation: null, method: "" }),
			...dependencies,
		},
	});
	return {
		recovery,
		captured: fake.captured,
		normalizedCount: () => normalizedCount,
	};
}

test("late evidence readiness is a read-only property and cutoff-scoped probe", async () => {
	const available = createRecovery({ events: [eventFixture()] });
	assert.equal(await available.recovery.hasCandidates(), true);
	assert.equal(available.captured.updates.length, 0);
	const filter = available.captured.exists[0];
	assert.equal(filter.hotelId, HOTEL_ID);
	assert.equal(filter.status, "failed");
	assert.equal(filter.errorCode, LATE_EVIDENCE_WAITING_ERROR);
	const pushCutoff = filter.$and[0].$or.find(
		(branch) => branch.source === "push"
	);
	assert.equal(pushCutoff.receivedAt.$gte, CUTOFF);
	assert.equal(pushCutoff.sourceUpdatedAt.$gte, CUTOFF);

	const empty = createRecovery({
		events: [],
		modelOptions: { candidateExists: false },
	});
	assert.equal(await empty.recovery.hasCandidates(), false);
});

test("late queued authenticated email evidence requeues without requiring a PMS record", async () => {
	const event = eventFixture();
	let existingLookupCount = 0;
	const { recovery, captured } = createRecovery({
		events: [event],
		dependencies: {
			loadQueuedEmailCommercialBridge: async ({
				normalized,
				provider,
				config,
			}) => {
				assert.equal(normalized.hotelRunnerReservationId, "hr-synthetic-1");
				assert.equal(provider, "synthetic");
				assert.equal(config.hotelId, HOTEL_ID);
				return {
					ok: true,
					evidence: { evidenceHash: EVIDENCE_HASH_A },
				};
			},
			findLinkedReservation: async () => {
				existingLookupCount += 1;
				return { reservation: null, method: "" };
			},
		},
	});

	const result = await recovery.scanOnce({ now: NOW });
	assert.deepEqual(result, { status: "requeued", scanned: 1, requeued: true });
	assert.equal(
		existingLookupCount,
		0,
		"the active queued proof is sufficient to retry creation"
	);
	assert.equal(captured.updates.length, 1);
	const [{ filter, update }] = captured.updates;
	assert.equal(filter._id, event._id);
	assert.equal(filter.hotelId, HOTEL_ID);
	assert.equal(filter.status, "failed");
	assert.equal(filter.errorCode, LATE_EVIDENCE_WAITING_ERROR);
	assert.equal(filter.payloadHash, event.payloadHash);
	assert.equal(filter.canonicalHash, event.canonicalHash);
	assert.equal(filter.attempts, 8);
	assert.equal(filter.updatedAt, event.updatedAt);
	assert.deepEqual(filter.leaseOwner, { $in: ["", null] });
	assert.deepEqual(filter.leaseUntil, { $in: [null] });
	assert.deepEqual(filter["result.lateEvidenceRecovery.evidenceHash"], {
		$ne: EVIDENCE_HASH_A,
	});
	assert.equal(update.$set.status, "pending");
	assert.equal(update.$set.attempts, 0);
	assert.equal(update.$set.nextAttemptAt, NOW);
	assert.deepEqual(update.$set["result.lateEvidenceRecovery"], {
		version: 1,
		evidenceHash: EVIDENCE_HASH_A,
		evidenceKind: "authenticated_ota_email_queue",
		recoveredAt: NOW,
	});
	assert.deepEqual(update.$unset, {
		leaseOwner: 1,
		leaseAcquiredAt: 1,
		leaseUntil: 1,
	});

	const findFilter = captured.find[0];
	assert.equal(findFilter.hotelId, HOTEL_ID);
	assert.equal(findFilter.status, "failed");
	assert.equal(findFilter.errorCode, LATE_EVIDENCE_WAITING_ERROR);
	assert.deepEqual(findFilter.leaseOwner, { $in: ["", null] });
	const pushCutoff = findFilter.$and[0].$or.find(
		(branch) => branch.source === "push"
	);
	assert.equal(pushCutoff.receivedAt.$gte, CUTOFF);
	assert.equal(pushCutoff.sourceUpdatedAt.$gte, CUTOFF);
});

test("late authenticated provider PMS evidence requeues through the shared handoff proof", async () => {
	const existing = { _id: "6a7000000000000000000100" };
	let proofArguments = null;
	const { recovery, captured } = createRecovery({
		events: [eventFixture()],
		dependencies: {
			findLinkedReservation: async () => ({
				reservation: existing,
				method: "provider_or_hr_alias_plus_stay",
			}),
			loadEmailCommercialBridge: async () => ({
				ok: false,
				reason: "missing_inbound_email_reference",
			}),
			authenticatedProviderExistingHandoffProof: (arguments_) => {
				proofArguments = arguments_;
				return { ok: true, evidenceHash: EVIDENCE_HASH_B };
			},
		},
	});

	const result = await recovery.scanOnce({ now: NOW });
	assert.equal(result.requeued, true);
	assert.equal(proofArguments.existing, existing);
	assert.equal(proofArguments.hotel._id, HOTEL_ID);
	assert.equal(proofArguments.linkMethod, "provider_or_hr_alias_plus_stay");
	assert.equal(captured.updates.length, 1);
	assert.equal(
		captured.updates[0].update.$set["result.lateEvidenceRecovery"].evidenceKind,
		"authenticated_provider"
	);
});

test("invalid and unchanged evidence leave a failed event terminal without write churn", async () => {
	for (const scenario of ["invalid", "unchanged"]) {
		const event = eventFixture(
			scenario === "unchanged"
				? {
						result: {
							lateEvidenceRecovery: { evidenceHash: EVIDENCE_HASH_A },
						},
				  }
				: {}
		);
		const { recovery, captured } = createRecovery({
			events: [event],
			dependencies: {
				loadQueuedEmailCommercialBridge: async () =>
					scenario === "unchanged"
						? { ok: true, evidence: { evidenceHash: EVIDENCE_HASH_A } }
						: { ok: true, evidence: { evidenceHash: "not-a-proof" } },
				authenticatedProviderExistingHandoffProof: () => ({
					ok: false,
					reason: "proof_rejected",
				}),
			},
		});
		const result = await recovery.scanOnce({ now: NOW });
		assert.equal(result.requeued, false, scenario);
		assert.equal(captured.updates.length, 0, scenario);
	}
});

test("late evidence scanning is bounded and a lost event CAS never reports a requeue", async () => {
	const events = Array.from(
		{ length: DEFAULT_LATE_EVIDENCE_SCAN_LIMIT + 5 },
		(_, index) =>
			eventFixture({
				_id: `6a700000000000000000${String(index).padStart(4, "0")}`,
			})
	);
	const bounded = createRecovery({ events });
	const boundedResult = await bounded.recovery.scanOnce({
		now: NOW,
		limit: 10_000,
	});
	assert.equal(boundedResult.scanned, DEFAULT_LATE_EVIDENCE_SCAN_LIMIT);
	assert.equal(bounded.normalizedCount(), DEFAULT_LATE_EVIDENCE_SCAN_LIMIT);
	assert.deepEqual(bounded.captured.limits, [DEFAULT_LATE_EVIDENCE_SCAN_LIMIT]);

	const lost = createRecovery({
		events: [eventFixture()],
		modelOptions: { modifiedCount: 0 },
		dependencies: {
			loadQueuedEmailCommercialBridge: async () => ({
				ok: true,
				evidence: { evidenceHash: EVIDENCE_HASH_A },
			}),
		},
	});
	const lostResult = await lost.recovery.scanOnce({ now: NOW });
	assert.deepEqual(lostResult, {
		status: "scanned",
		scanned: 1,
		requeued: false,
	});
	assert.equal(lost.captured.updates.length, 1);
});
