/** @format */

const test = require("node:test");
const assert = require("node:assert/strict");

const HotelRunnerOtaFallbackJob = require("../models/hotelrunner_ota_fallback_job");
const Reservations = require("../models/reservations");
const HotelDetails = require("../models/hotel_details");
const {
	buildHotelRunnerFirstFallbackCreationMarker,
} = require("./hotelrunnerFirstOtaFallbackProvenance");
const {
	buildCreationAuthorization,
} = require("./hotelrunnerFallbackIngressGate");
const {
	DEFAULT_GRACE_MS,
	DEFAULT_LEASE_MS,
	TARGETED_LOOKUP_EVENT_MARKER_PATH,
	buildConfirmedEmptyProof,
	buildHotelRunnerPriorityWorkQuery,
	buildIdentity,
	canonicalProvider,
	classifyHotelRunnerLookupEnvelope,
	classifyLocalHotelRunnerState,
	createArchiveFingerprint,
	createHotelRunnerFirstOtaFallbackCoordinator,
	defaultFinalizeInboundAudit,
	defaultInspectLocalHotelRunnerState,
	defaultMarkRecoveredArchivedEmail,
	defaultReconcileArchivedEmail,
	validConfirmedEmptyProof,
} = require("./hotelrunnerFirstOtaFallback");

const HOTEL_ID = "6a40b6a1a6efe70450536038";
const OTHER_HOTEL_ID = "6a40b6a1a6efe70450536039";
const EMAIL_ID = "6a789cb5f77fb5bdaf73b0b1";
const OTHER_EMAIL_ID = "6a789cb5f77fb5bdaf73b0b2";
const RESERVATION_ID = "6a789cea66c058f4ab621ebf";
const EVENT_ID = "6a789cf2f77fb5bdaf73b0b3";
const CONFIRMATION = "2039878308";
const START = new Date("2026-08-09T16:00:00.000Z");
const OWNER_ID = "6a40b6a1a6efe70450536040";

const clone = (value) => {
	if (value === undefined) return undefined;
	if (value === null || typeof value !== "object") return value;
	if (value instanceof Date) return new Date(value);
	if (Array.isArray(value)) return value.map(clone);
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
};

const applyUpdate = (document, update = {}) => {
	for (const [key, value] of Object.entries(update.$set || {})) document[key] = clone(value);
	for (const [key, value] of Object.entries(update.$inc || {})) {
		document[key] = Number(document[key] || 0) + Number(value || 0);
	}
	for (const key of Object.keys(update.$unset || {})) delete document[key];
	return document;
};

const identityMapKey = (value) =>
	`${String(value.hotelId)}|${value.provider}|${value.confirmationNumber}`;

function createMemoryJobStore() {
	const jobs = new Map();
	let sequence = 1;
	const owned = (stored, job, now) =>
		stored &&
		stored.status === "processing" &&
		stored.leaseOwner === job.leaseOwner &&
		stored.leaseToken === job.leaseToken &&
		stored.archiveFingerprint === job.archiveFingerprint &&
		stored.leaseUntil instanceof Date &&
		stored.leaseUntil.getTime() > now.getTime();
	return {
		jobs,
		async upsertIdentity(document, now) {
			const key = identityMapKey(document);
			let stored = jobs.get(key);
			if (!stored) {
				stored = {
					_id: `6a789cb5f77fb5bdaf73b1${(sequence++)
						.toString(16)
						.padStart(2, "0")}`,
					attemptCount: 0,
					lookupAttemptCount: 0,
					seenCount: 0,
					createdAt: new Date(now),
					...clone(document),
				};
				jobs.set(key, stored);
			}
			stored.lastSeenAt = new Date(now);
			stored.seenCount += 1;
			return clone(stored);
		},
		async recordCollision(job, collision, now) {
			const stored = [...jobs.values()].find((candidate) => candidate._id === job._id);
			if (!stored || stored.archiveFingerprint !== job.archiveFingerprint) return null;
			stored.identityConflict = true;
			stored.lastErrorCode = "HOTELRUNNER_FALLBACK_IDENTITY_COLLISION";
			stored.identityCollisions = [...(stored.identityCollisions || []), clone(collision)].slice(-10);
			if (
				["completed_api", "completed_email_fallback", "needs_review"].includes(
					stored.status
				)
			) {
				return clone(stored);
			}
			if (
				stored.status !== "processing" ||
				!stored.leaseUntil ||
				stored.leaseUntil.getTime() <= now.getTime()
			) {
				stored.status = "retry";
				stored.completedAt = null;
				stored.nextAttemptAt = new Date(now);
				stored.lastDecision = "identity_collision_pending_review";
				delete stored.leaseOwner;
				delete stored.leaseToken;
				delete stored.leaseUntil;
				delete stored.negativeLookupProof;
			}
			return clone(stored);
		},
		async claim({ hotelId, instanceId, leaseToken, now, leaseUntil, maxAttempts }) {
			const candidates = [...jobs.values()]
				.filter(
					(job) =>
						String(job.hotelId) === String(hotelId) &&
						["awaiting_hotelrunner", "retry", "processing"].includes(job.status) &&
						job.attemptCount < maxAttempts &&
						job.nextAttemptAt.getTime() <= now.getTime() &&
						(!job.leaseUntil || job.leaseUntil.getTime() <= now.getTime())
				)
				.sort((left, right) => left.nextAttemptAt - right.nextAttemptAt);
			const stored = candidates[0];
			if (!stored) return null;
			stored.status = "processing";
			stored.leaseOwner = instanceId;
			stored.leaseToken = leaseToken;
			stored.leaseAcquiredAt = new Date(now);
			stored.leaseUntil = new Date(leaseUntil);
			stored.lastStartedAt = new Date(now);
			stored.attemptCount += 1;
			return clone(stored);
		},
		async markExhausted({
			hotelId,
			now,
			maxAttempts,
			instanceId,
			leaseToken,
			leaseUntil,
		}) {
			const stored = [...jobs.values()].find(
				(job) =>
					String(job.hotelId) === String(hotelId) &&
					["awaiting_hotelrunner", "retry", "processing"].includes(job.status) &&
					job.attemptCount >= maxAttempts &&
					job.nextAttemptAt.getTime() <= now.getTime() &&
					(!job.leaseUntil || job.leaseUntil.getTime() <= now.getTime())
			);
			if (!stored) return null;
			stored.status = "processing";
			stored.leaseOwner = instanceId;
			stored.leaseToken = leaseToken;
			stored.leaseAcquiredAt = new Date(now);
			stored.leaseUntil = new Date(leaseUntil);
			stored.lastStartedAt = new Date(now);
			return clone(stored);
		},
		async renewOwned(job, now, leaseUntil) {
			const stored = [...jobs.values()].find((candidate) => candidate._id === job._id);
			if (!owned(stored, job, now)) return null;
			stored.leaseUntil = new Date(leaseUntil);
			return clone(stored);
		},
		async updateOwned(job, update, now) {
			const stored = [...jobs.values()].find((candidate) => candidate._id === job._id);
			if (!owned(stored, job, now)) return null;
			applyUpdate(stored, update);
			return clone(stored);
		},
		async findByIdentity(identity) {
			return clone(jobs.get(identityMapKey(identity)) || null);
		},
		async findById(jobId) {
			return clone([...jobs.values()].find((job) => job._id === jobId) || null);
		},
		async hasDueWork({ hotelId, now }) {
			return [...jobs.values()].some(
				(job) =>
					String(job.hotelId) === String(hotelId) &&
					["awaiting_hotelrunner", "retry", "processing"].includes(job.status) &&
					job.nextAttemptAt.getTime() <= now.getTime() &&
					(!job.leaseUntil || job.leaseUntil.getTime() <= now.getTime())
			);
		},
	};
}

function mutableClock(initial = START) {
	let current = new Date(initial);
	return {
		now: () => new Date(current),
		advance(milliseconds) {
			current = new Date(current.getTime() + milliseconds);
		},
	};
}

function archivedEmail(overrides = {}) {
	const inboundEmailId = overrides._id || EMAIL_ID;
	const provider = overrides.provider || "agoda";
	const confirmationNumber = overrides.confirmationNumber || CONFIRMATION;
	const base = {
		_id: inboundEmailId,
		hotelId: HOTEL_ID,
		provider,
		intent: "new_reservation",
		eventType: "new",
		processingStatus: "parsed_awaiting_hotelrunner",
		emailHash: "a".repeat(64),
		senderAuthentication: {
			authenticatedAligned: true,
			trustedProvider: provider,
			method: "dkim",
		},
		confirmationNumber,
		hotelRunnerFirstFallback: {
			status: "archive_ready",
			resolvedHotelProof: {
				version: 1,
				hotelId: HOTEL_ID,
				belongsTo: OWNER_ID,
				currency: "SAR",
				activateHotel: true,
				xHotelProActive: true,
			},
		},
		normalizedReservation: {
			inboundEmailId,
			provider,
			intent: "new_reservation",
			eventType: "new",
			confirmationNumber,
			reservationId: confirmationNumber,
			trustedTransportProvider: provider,
			sourceSenderAuthenticated: true,
			sourceSenderTrusted: true,
			hotelName: "Zad Ajyad",
			sourcePresence: {
				confirmationNumber: true,
				hotelName: true,
			},
			amount: 588,
			totalAmountSar: 588,
			netAmountSar: 363.78,
			source: {
				textHash: "b".repeat(64),
				receivedAt: new Date(START),
			},
		},
	};
	return {
		...base,
		...overrides,
		normalizedReservation: {
			...base.normalizedReservation,
			...(overrides.normalizedReservation || {}),
		},
		hotelRunnerFirstFallback: {
			...base.hotelRunnerFirstFallback,
			...(overrides.hotelRunnerFirstFallback || {}),
		},
	};
}

function defaultReconciliationFixture(mode = "api_commercial_enrichment") {
	const audit = archivedEmail();
	const identity = buildIdentity({
		hotelId: HOTEL_ID,
		provider: "agoda",
		confirmationNumber: CONFIRMATION,
	});
	const fingerprints = createArchiveFingerprint({ identity, audit });
	const job = {
		_id: "job-default-reconciliation",
		...identity,
		...fingerprints,
		hrIdFingerprint: "f".repeat(64),
	};
	return {
		audit,
		identity,
		job,
		input: {
			mode,
			job,
			identity,
			inboundEmailId: EMAIL_ID,
			normalizedReservation: audit.normalizedReservation,
			archiveFingerprint: fingerprints.archiveFingerprint,
			reservationId:
				mode === "api_commercial_enrichment" ? RESERVATION_ID : "",
			local:
				mode === "api_commercial_enrichment"
					? { kind: "api", reservationId: RESERVATION_ID }
					: null,
		},
	};
}

function directApiReservation(overrides = {}) {
	return {
		_id: RESERVATION_ID,
		hotelId: HOTEL_ID,
		belongsTo: OWNER_ID,
		otaIdentityKey: `agoda:${CONFIRMATION}`,
		reservation_id: CONFIRMATION,
		customer_details: { confirmation_number2: CONFIRMATION },
		supplierData: {
			otaProvider: "agoda",
			otaConfirmationNumber: CONFIRMATION,
			otaAutomationPipeline: "hotelrunner-background-worker",
			otaSourceAuthority: 4,
			hotelRunner: {
				transport: "hotelrunner_api",
				reservationId: "hotelrunner-direct-reservation",
				providerNumber: CONFIRMATION,
				channel: "agoda",
			},
		},
		...overrides,
	};
}

const activeHotel = (overrides = {}) => ({
	_id: HOTEL_ID,
	belongsTo: OWNER_ID,
	currency: "SAR",
	activateHotel: true,
	xHotelProActive: true,
	...overrides,
});

const config = {
	configured: true,
	projectionEnabled: true,
	hotelId: HOTEL_ID,
	hrIdFingerprint: "f".repeat(64),
};

function harness(options = {}) {
	const clock = options.clock || mutableClock();
	const jobStore = options.jobStore || createMemoryJobStore();
	const audits = options.audits || new Map([[EMAIL_ID, archivedEmail()]]);
	const calls = { lookup: 0, persist: 0, api: 0, fallback: 0 };
	const markers = [];
	const recoveryMarkers = [];
	const finalizations = [];
	const terminalNotifications = [];
	const dependencies = {
		clock: clock.now,
		random: () => 0,
		randomToken: (() => {
			let sequence = 0;
			return () => `token-${++sequence}`;
		})(),
		jobStore,
		...(options.hotelRunnerFirstFallbackIngressGate
			? {
					hotelRunnerFirstFallbackIngressGate:
						options.hotelRunnerFirstFallbackIngressGate,
			  }
			: {}),
		loadArchivedEmail: async (id) => clone(audits.get(String(id)) || null),
		loadCurrentHotel: async () =>
			options.currentHotel || {
				_id: HOTEL_ID,
				belongsTo: OWNER_ID,
				currency: "SAR",
				activateHotel: true,
				xHotelProActive: true,
			},
		inspectLocalHotelRunnerState:
			options.inspect || (async () => ({ kind: "absent", code: "absent" })),
		isHotelRunnerPriorityQueueClear:
			options.queueClear || (async () => true),
		lookupHotelRunnerReservation: async (query) => {
			calls.lookup += 1;
			assert.deepEqual(query, {
				reservationNumber:
					options.expectedLookupConfirmation || CONFIRMATION,
				undelivered: false,
				page: 1,
				perPage: 50,
			});
			return options.lookup
				? options.lookup(query)
				: { reservations: [], count: 0, current_page: 1, pages: 0 };
		},
		normalizeHotelRunnerReservation:
			options.normalize ||
			((row) => ({
				...row,
				issues: [],
				hotelRunnerReservationId: row.id,
				providerNumber: row.provider_number,
				channel: row.channel,
			})),
		persistHotelRunnerLookupMatch: async (context) => {
			calls.persist += 1;
			return options.persist
				? options.persist(context)
				: { eventId: EVENT_ID, status: "pending", integrityConflict: false };
		},
		markHotelRunnerLookupEventProjectable: async (context) => {
			markers.push(clone(context));
			return options.markProjectable
				? options.markProjectable(context)
				: true;
		},
		finalizeInboundAudit: async (context) => {
			finalizations.push(clone(context));
			return options.finalizeAudit ? options.finalizeAudit(context) : true;
		},
		findRecoverableArchivedEmails: async (context) =>
			options.recoverableAudits ? options.recoverableAudits(context) : [],
		markRecoveredArchivedEmail: async (context) => {
			recoveryMarkers.push(clone(context));
			return true;
		},
		enqueueTerminalNotification: async (job) => {
			terminalNotifications.push(clone(job));
			return true;
		},
		logger: { error() {} },
		reconcileApiReservationEmail: async (context) => {
			calls.api += 1;
			return options.reconcileApi
				? options.reconcileApi(context)
				: { status: "updated", reservationId: RESERVATION_ID };
		},
		...(options.useDefaultReconcileFallback
			? {}
			: {
					reconcileEmailFallback: async (context) => {
						calls.fallback += 1;
						return options.reconcileFallback
							? options.reconcileFallback(context)
							: { status: "created", reservationId: RESERVATION_ID };
					},
			  }),
		loadReservationById: async (reservationId) =>
			options.loadReservation
				? options.loadReservation(reservationId)
				: {
						_id: reservationId,
						hotelId: HOTEL_ID,
						otaIdentityKey: `agoda:${CONFIRMATION}`,
						reservation_id: CONFIRMATION,
						customer_details: { confirmation_number2: CONFIRMATION },
						supplierData: {
							otaProvider: "agoda",
							otaConfirmationNumber: CONFIRMATION,
						},
					},
	};
	const coordinator = createHotelRunnerFirstOtaFallbackCoordinator({
		config: options.config || config,
		instanceId: options.instanceId || "worker-a",
		graceMs: options.graceMs,
		leaseMs: options.leaseMs,
		negativeProofTtlMs: options.negativeProofTtlMs,
		maxAttempts: options.maxAttempts,
		dependencies,
	});
	return {
		audits,
		calls,
		clock,
		coordinator,
		finalizations,
		jobStore,
		markers,
		recoveryMarkers,
		terminalNotifications,
	};
}

async function enqueueDefault(context) {
	return context.coordinator.enqueueArchivedEmail({
		inboundEmailId: EMAIL_ID,
		hotelId: HOTEL_ID,
		provider: "agoda",
		confirmationNumber: CONFIRMATION,
	});
}

test("fallback job schema has the exact identity uniqueness and durable state queue", () => {
	const indexes = HotelRunnerOtaFallbackJob.schema.indexes();
	assert.ok(
		indexes.some(
			([fields, options]) =>
				fields.hotelId === 1 &&
				fields.provider === 1 &&
				fields.confirmationNumber === 1 &&
				options.unique === true &&
				options.name === "uniq_hotelrunner_ota_fallback_identity"
		)
	);
	assert.deepEqual(HotelRunnerOtaFallbackJob.schema.path("status").enumValues, [
		"awaiting_hotelrunner",
		"processing",
		"retry",
		"completed_api",
		"completed_email_fallback",
		"needs_review",
	]);
});

test("provider aliases canonicalize while HotelRunner remains transport-only", () => {
	assert.equal(canonicalProvider("AgodaYCS5"), "agoda");
	assert.equal(canonicalProvider("Booking.com"), "booking");
	assert.equal(canonicalProvider("CTrip.com"), "trip");
	assert.equal(canonicalProvider("HotelRunner"), "hotelrunner");
	assert.equal(canonicalProvider("OTA"), "");
	assert.throws(
		() =>
			buildIdentity({
				hotelId: HOTEL_ID,
				provider: "hotelrunner",
				confirmationNumber: CONFIRMATION,
			}),
		(error) => error.code === "HOTELRUNNER_FALLBACK_PROVIDER_INVALID"
	);
	assert.ok(HotelRunnerOtaFallbackJob.schema.path("notificationOutboxStatus"));
	assert.ok(HotelRunnerOtaFallbackJob.schema.path("notificationOutboxId"));
	assert.ok(HotelRunnerOtaFallbackJob.schema.path("notificationOutboxEnqueuedAt"));
	const terminal = new HotelRunnerOtaFallbackJob({
		hotelId: HOTEL_ID,
		provider: "agoda",
		confirmationNumber: CONFIRMATION,
		lookupConfirmationNumber: CONFIRMATION,
		lookupConfirmationHash: "a".repeat(64),
		identityKey: `agoda:${CONFIRMATION}`,
		hrIdFingerprint: "b".repeat(64),
		inboundEmailId: EMAIL_ID,
		inboundEmailHash: "c".repeat(64),
		normalizedReservationHash: "d".repeat(64),
		resolvedHotelProofHash: "e".repeat(64),
		archiveFingerprint: "f".repeat(64),
		notBefore: START,
		nextAttemptAt: START,
		notificationOutboxStatus: "pending",
	});
	assert.equal(terminal.validateSync(), undefined);
	assert.equal(terminal.notificationOutboxStatus, "pending");
});

test("enqueue requires the persisted authenticated direct-OTA new audit and applies 180 seconds", async () => {
	const context = harness();
	const result = await enqueueDefault(context);
	assert.equal(result.job.status, "awaiting_hotelrunner");
	assert.equal(
		result.job.notBefore.getTime() - START.getTime(),
		DEFAULT_GRACE_MS
	);
	assert.equal(result.job.nextAttemptAt.toISOString(), result.job.notBefore.toISOString());
	assert.equal(result.job.inboundEmailId, EMAIL_ID);
	assert.equal(result.job.lookupConfirmationNumber, CONFIRMATION);
	assert.match(result.job.lookupConfirmationHash, /^[a-f0-9]{64}$/);
	assert.match(result.job.normalizedReservationHash, /^[a-f0-9]{64}$/);
	assert.match(result.job.archiveFingerprint, /^[a-f0-9]{64}$/);
	assert.equal(await context.coordinator.claimJob(), null, "grace must block an early claim");
	assert.equal(await context.coordinator.hasDueWork(), false);
	context.clock.advance(DEFAULT_GRACE_MS);
	assert.equal(await context.coordinator.hasDueWork(), true);
});

test("unauthenticated, relayed, wrong-property, and non-new emails cannot enter the queue", async () => {
	for (const [name, audit] of [
		[
			"unauthenticated",
			archivedEmail({
				senderAuthentication: { authenticatedAligned: false, trustedProvider: "agoda" },
			}),
		],
		[
			"relay",
			archivedEmail({
				normalizedReservation: { trustedTransportProvider: "hotelrunner" },
			}),
		],
		["not-new", archivedEmail({ eventType: "modified" })],
	]) {
		const context = harness({ audits: new Map([[EMAIL_ID, audit]]) });
		await assert.rejects(enqueueDefault(context), { name: "HotelRunnerFirstFallbackError" }, name);
	}
	const wrongHotel = harness();
	await assert.rejects(
		wrongHotel.coordinator.enqueueArchivedEmail({
			inboundEmailId: EMAIL_ID,
			hotelId: OTHER_HOTEL_ID,
			provider: "agoda",
			confirmationNumber: CONFIRMATION,
		}),
		(error) => error.code === "HOTELRUNNER_FALLBACK_PROPERTY_MISMATCH"
	);
});

test("same archived identity is idempotent; a different archive is an identity collision", async () => {
	const secondAudit = archivedEmail({
		_id: OTHER_EMAIL_ID,
		emailHash: "c".repeat(64),
		normalizedReservation: { inboundEmailId: OTHER_EMAIL_ID, amount: 999 },
	});
	const context = harness({
		audits: new Map([
			[EMAIL_ID, archivedEmail()],
			[OTHER_EMAIL_ID, secondAudit],
		]),
	});
	const first = await enqueueDefault(context);
	const duplicate = await enqueueDefault(context);
	assert.equal(duplicate.job._id, first.job._id);
	assert.equal(duplicate.collision, false);
	assert.equal(duplicate.job.seenCount, 2);
	const collision = await context.coordinator.enqueueArchivedEmail({
		inboundEmailId: OTHER_EMAIL_ID,
		hotelId: HOTEL_ID,
		provider: "agoda",
		confirmationNumber: CONFIRMATION,
	});
	assert.equal(collision.collision, true);
	assert.equal(collision.job.status, "retry");
	assert.equal(collision.job.identityConflict, true);
	assert.equal(collision.job.identityCollisions.length, 1);
	const terminal = await context.coordinator.runOnce();
	assert.equal(terminal.status, "needs_review");
	assert.equal(terminal.lastDecision, "identity_collision");
	assert.equal(context.finalizations.length, 1);
});

test("a conflicting email never revokes an active first-archive mapper lease", async () => {
	const secondAudit = archivedEmail({
		_id: OTHER_EMAIL_ID,
		emailHash: "c".repeat(64),
		normalizedReservation: { inboundEmailId: OTHER_EMAIL_ID, amount: 999 },
	});
	const context = harness({
		audits: new Map([
			[EMAIL_ID, archivedEmail()],
			[OTHER_EMAIL_ID, secondAudit],
		]),
	});
	await enqueueDefault(context);
	context.clock.advance(DEFAULT_GRACE_MS);
	const firstClaim = await context.coordinator.claimJob();
	assert.equal(firstClaim.status, "processing");
	const collision = await context.coordinator.enqueueArchivedEmail({
		inboundEmailId: OTHER_EMAIL_ID,
		hotelId: HOTEL_ID,
		provider: "agoda",
		confirmationNumber: CONFIRMATION,
	});
	assert.equal(collision.collision, true);
	assert.equal(collision.job.status, "processing");
	assert.equal(collision.job.leaseToken, firstClaim.leaseToken);
	const completed = await context.coordinator.processClaimedJob(firstClaim);
	assert.equal(completed.status, "completed_email_fallback");
	assert.equal(context.finalizations.length, 1);
});

test("a later distinct archive cannot reopen a terminal fallback job", async () => {
	for (const mode of ["completed_api", "completed_email_fallback"]) {
		const secondAudit = archivedEmail({
			_id: OTHER_EMAIL_ID,
			emailHash: "c".repeat(64),
			normalizedReservation: { inboundEmailId: OTHER_EMAIL_ID, amount: 999 },
		});
		const context = harness({
			audits: new Map([
				[EMAIL_ID, archivedEmail()],
				[OTHER_EMAIL_ID, secondAudit],
			]),
			inspect:
				mode === "completed_api"
					? async () => ({
							kind: "api",
							reservationId: RESERVATION_ID,
							eventId: EVENT_ID,
						})
					: undefined,
		});
		await enqueueDefault(context);
		context.clock.advance(DEFAULT_GRACE_MS);
		const terminal = await context.coordinator.runOnce();
		assert.equal(terminal.status, mode);
		const originalCompletedAt = terminal.completedAt.toISOString();
		const collision = await context.coordinator.enqueueArchivedEmail({
			inboundEmailId: OTHER_EMAIL_ID,
			hotelId: HOTEL_ID,
			provider: "agoda",
			confirmationNumber: CONFIRMATION,
		});
		assert.equal(collision.collision, true);
		assert.equal(collision.job.status, mode);
		assert.equal(collision.job.completedAt.toISOString(), originalCompletedAt);
		assert.equal(collision.job.identityCollisions.length, 1);
		assert.equal(await context.coordinator.runOnce(), null);
		assert.equal(context.finalizations.length, 1);
	}
});

test("pending HotelRunner local work blocks lookup and email fallback", async () => {
	const context = harness({
		inspect: async () => ({ kind: "pending", code: "event_pending" }),
	});
	await enqueueDefault(context);
	context.clock.advance(DEFAULT_GRACE_MS);
	const result = await context.coordinator.runOnce();
	assert.equal(result.status, "retry");
	assert.equal(result.lastDecision, "hotelrunner_projection_pending");
	assert.deepEqual(context.calls, { lookup: 0, persist: 0, api: 0, fallback: 0 });
});

test("needs-mapping evidence keeps the email job alive until HotelRunner projection recovers", async () => {
	let projectionRecovered = false;
	const context = harness({
		inspect: async () =>
			projectionRecovered
				? {
						kind: "api",
						reservationId: RESERVATION_ID,
						eventId: EVENT_ID,
				  }
				: {
						events: [
							{
								_id: EVENT_ID,
								hotelId: HOTEL_ID,
								providerNumber: CONFIRMATION,
								channel: "agoda",
								hotelRunnerReservationId: "hotelrunner-needs-mapping",
								status: "needs_mapping",
								source: "push",
								errorCode: "hotelrunner_room_mapping_stale",
								result: {
									code: "hotelrunner_room_mapping_stale",
									staleInvCodes: ["INV-1"],
									missingInvCodes: ["INV-1"],
								},
							},
						],
						mirrors: [],
						reservations: [],
				  },
	});
	await enqueueDefault(context);
	context.clock.advance(DEFAULT_GRACE_MS);

	const waiting = await context.coordinator.runOnce();
	assert.equal(waiting.status, "retry");
	assert.equal(waiting.lastDecision, "hotelrunner_projection_pending");
	assert.equal(waiting.attemptCount, 0);
	assert.deepEqual(context.calls, {
		lookup: 0,
		persist: 0,
		api: 0,
		fallback: 0,
	});
	assert.equal(context.finalizations.length, 0);

	projectionRecovered = true;
	context.clock.advance(5_000);
	const completed = await context.coordinator.runOnce();
	assert.equal(completed.status, "completed_api");
	assert.equal(completed.reservationMongoId, RESERVATION_ID);
	assert.deepEqual(context.calls, {
		lookup: 0,
		persist: 0,
		api: 1,
		fallback: 0,
	});
	assert.equal(context.finalizations.length, 1);
});

test("a failed currency-waiting event keeps the email job non-consuming for late evidence recovery", async () => {
	const context = harness({
		inspect: async () => ({
			events: [
				{
					_id: EVENT_ID,
					hotelId: HOTEL_ID,
					providerNumber: CONFIRMATION,
					channel: "agoda",
					hotelRunnerReservationId: "hotelrunner-late-evidence",
					status: "failed",
					source: "push",
					errorCode: "hotelrunner_currency_waiting_for_email_bridge",
				},
			],
			mirrors: [],
			reservations: [],
		}),
	});
	await enqueueDefault(context);
	context.clock.advance(DEFAULT_GRACE_MS);

	const waiting = await context.coordinator.runOnce();
	assert.equal(waiting.status, "retry");
	assert.equal(waiting.lastDecision, "hotelrunner_projection_pending");
	assert.equal(waiting.attemptCount, 0);
	assert.equal(context.finalizations.length, 0);
	assert.deepEqual(context.calls, {
		lookup: 0,
		persist: 0,
		api: 0,
		fallback: 0,
	});
});

test("an API-observed marker survives an event-insert crash and redelivery still wins", async () => {
	let eventVisible = false;
	const context = harness({
		inspect: async () =>
			eventVisible
				? {
						kind: "api",
						reservationId: RESERVATION_ID,
						eventId: EVENT_ID,
				  }
				: { kind: "absent", code: "absent" },
	});
	const queued = await enqueueDefault(context);
	const stored = context.jobStore.jobs.get(identityMapKey(queued.job));
	// The callback linearized on the fallback identity, then its event upsert
	// crashed. Retaining a prior proof here verifies that the barrier revokes all
	// email authorization evidence while event visibility catches up.
	stored.ingressDecision = {
		status: "api_observed",
		apiObservationKey: "hotelrunner-delivery-retry-key",
		apiObservedAt: new Date(START),
	};
	stored.negativeLookupProof = { proofId: "must-be-cleared" };

	context.clock.advance(DEFAULT_GRACE_MS);
	const waiting = await context.coordinator.runOnce();
	assert.equal(waiting.status, "retry");
	assert.equal(
		waiting.lastDecision,
		"hotelrunner_api_observed_event_pending"
	);
	assert.equal(waiting.lastErrorCode, "HOTELRUNNER_FALLBACK_API_OBSERVED_EVENT_PENDING");
	assert.equal(waiting.attemptCount, 0, "the visibility gap is not a failure attempt");
	assert.equal(waiting.negativeLookupProof, undefined);
	assert.deepEqual(context.calls, { lookup: 0, persist: 0, api: 0, fallback: 0 });
	assert.equal(context.finalizations.length, 0);

	// HotelRunner redelivery successfully inserts the event (or the first insert
	// becomes visible) before the non-consuming retry is reclaimed.
	eventVisible = true;
	context.clock.advance(5_000);
	const completed = await context.coordinator.runOnce();
	assert.equal(completed.status, "completed_api");
	assert.equal(completed.reservationMongoId, RESERVATION_ID);
	assert.deepEqual(context.calls, { lookup: 0, persist: 0, api: 1, fallback: 0 });
	assert.equal(context.finalizations.length, 1);
});

test("an API marker arriving after final inspection is refreshed before mapper entry", async () => {
	let context;
	let queueChecks = 0;
	context = harness({
		queueClear: async () => {
			queueChecks += 1;
			if (queueChecks === 2) {
				const stored = context.jobStore.jobs.get(
					`${HOTEL_ID}|agoda|${CONFIRMATION}`
				);
				stored.ingressDecision = {
					status: "api_observed",
					apiObservationKey: "callback-after-final-inspect",
					apiObservedAt: context.clock.now(),
				};
			}
			return true;
		},
	});
	await enqueueDefault(context);
	context.clock.advance(DEFAULT_GRACE_MS);

	const waiting = await context.coordinator.runOnce();
	assert.equal(queueChecks, 2);
	assert.equal(waiting.status, "retry");
	assert.equal(waiting.lastDecision, "hotelrunner_api_observed_event_pending");
	assert.equal(waiting.attemptCount, 0);
	assert.equal(waiting.negativeLookupProof, undefined);
	assert.deepEqual(context.calls, { lookup: 1, persist: 0, api: 0, fallback: 0 });
	assert.equal(context.finalizations.length, 0);
});

test("a mapper authorization CAS lost to the callback uses the non-consuming API barrier", async () => {
	const context = harness({
		reconcileFallback: async () => {
			const error = new Error(
				"HotelRunner callback won before the final email creation CAS."
			);
			error.code = "HOTELRUNNER_FALLBACK_API_OBSERVED_BEFORE_EMAIL";
			error.retryable = true;
			throw error;
		},
	});
	await enqueueDefault(context);
	context.clock.advance(DEFAULT_GRACE_MS);

	const waiting = await context.coordinator.runOnce();
	assert.equal(waiting.status, "retry");
	assert.equal(waiting.lastDecision, "hotelrunner_api_observed_event_pending");
	assert.equal(
		waiting.lastErrorCode,
		"HOTELRUNNER_FALLBACK_API_OBSERVED_EVENT_PENDING"
	);
	assert.equal(waiting.attemptCount, 0);
	assert.equal(waiting.negativeLookupProof, undefined);
	assert.deepEqual(context.calls, { lookup: 1, persist: 0, api: 0, fallback: 1 });
	assert.equal(context.finalizations.length, 0);
});

test("pre-cutoff push cannot deadlock a fresh exact HotelRunner lookup", async () => {
	const cutoff = new Date("2026-08-09T15:30:00.000Z");
	const context = harness({
		config: { ...config, projectionNotBefore: cutoff },
		inspect: async () => ({
			events: [
				{
					_id: EVENT_ID,
					hotelId: HOTEL_ID,
					status: "pending",
					source: "push",
					hotelRunnerReservationId: "legacy-40382472",
					providerNumber: CONFIRMATION,
					channel: "agoda",
					receivedAt: new Date("2026-08-09T15:31:00.000Z"),
					sourceUpdatedAt: new Date("2026-08-09T15:29:00.000Z"),
				},
			],
			mirrors: [],
			reservations: [],
		}),
	});
	await enqueueDefault(context);
	context.clock.advance(DEFAULT_GRACE_MS);
	const result = await context.coordinator.runOnce();
	assert.equal(result.status, "completed_email_fallback");
	assert.equal(context.calls.lookup, 1);
	assert.equal(context.calls.fallback, 1);
});

test("ordinary HotelRunner projection waits never consume the bounded failure budget", async () => {
	const context = harness({
		maxAttempts: 3,
		inspect: async () => ({ kind: "pending", code: "event_pending" }),
	});
	await enqueueDefault(context);
	context.clock.advance(DEFAULT_GRACE_MS);
	for (let cycle = 0; cycle < 6; cycle += 1) {
		const result = await context.coordinator.runOnce();
		assert.equal(result.status, "retry");
		assert.equal(result.lastDecision, "hotelrunner_projection_pending");
		assert.equal(result.attemptCount, 0);
		context.clock.advance(5_000);
	}
	assert.equal(context.finalizations.length, 0);
	assert.equal(context.calls.lookup, 0);
});

test("a direct API marker is commercially enriched from the intact archived email", async () => {
	let observed = null;
	const context = harness({
		inspect: async () => ({
			kind: "api",
			reservationId: RESERVATION_ID,
			eventId: EVENT_ID,
		}),
		reconcileApi: async (input) => {
			observed = input;
			return { status: "updated", reservationId: RESERVATION_ID };
		},
	});
	await enqueueDefault(context);
	context.clock.advance(DEFAULT_GRACE_MS);
	const result = await context.coordinator.runOnce();
	assert.equal(result.status, "completed_api");
	assert.equal(result.reservationMongoId, RESERVATION_ID);
	assert.equal(observed.mode, "api_commercial_enrichment");
	assert.equal(observed.normalizedReservation.amount, 588);
	assert.equal(observed.normalizedReservation.netAmountSar, 363.78);
	assert.equal(observed.inboundEmailId, EMAIL_ID);
	assert.equal(result.notificationOutboxStatus, "pending");
	assert.equal(context.terminalNotifications.length, 1);
	assert.deepEqual(context.calls, { lookup: 0, persist: 0, api: 1, fallback: 0 });
});

test("the default API boundary targets only the supplied direct-HotelRunner reservation", async () => {
	const fixture = defaultReconciliationFixture();
	let targetedCalls = 0;
	let broadCalls = 0;
	const result = await defaultReconcileArchivedEmail(fixture.input, {
		loadReconciliationReservation: async (reservationId) => {
			assert.equal(reservationId, RESERVATION_ID);
			return directApiReservation();
		},
		loadReconciliationHotel: async () => activeHotel(),
		otaReservationMapper: {
			detectConfirmationMatchFields: () => ["otaIdentityKey"],
			async reconcileDirectHotelRunnerOwnedEmail({ existing }) {
				targetedCalls += 1;
				assert.equal(existing._id, RESERVATION_ID);
				return { status: "updated", reservationId: RESERVATION_ID };
			},
			async reconcileOtaReservation() {
				broadCalls += 1;
				throw new Error("broad mapper must not run in API mode");
			},
		},
	});
	assert.equal(result.status, "updated");
	assert.equal(targetedCalls, 1);
	assert.equal(broadCalls, 0);
});

test("the default API boundary rejects a wrong supplied candidate with zero mapper writes", async () => {
	const fixture = defaultReconciliationFixture();
	let mutationCalls = 0;
	const result = await defaultReconcileArchivedEmail(fixture.input, {
		loadReconciliationReservation: async () =>
			directApiReservation({ hotelId: OTHER_HOTEL_ID }),
		loadReconciliationHotel: async () => activeHotel(),
		otaReservationMapper: {
			detectConfirmationMatchFields: () => ["otaIdentityKey"],
			async reconcileDirectHotelRunnerOwnedEmail() {
				mutationCalls += 1;
				return { status: "updated", reservationId: RESERVATION_ID };
			},
			async reconcileOtaReservation() {
				mutationCalls += 1;
				return { status: "created", reservationId: RESERVATION_ID };
			},
		},
	});
	assert.equal(result.status, "needs_review");
	assert.equal(
		result.skipReason,
		"hotelrunner_first_api_target_identity_conflict"
	);
	assert.equal(mutationCalls, 0);
});

test("the default boundary rejects normalized archive drift before any loader or mapper call", async () => {
	const fixture = defaultReconciliationFixture();
	fixture.input.normalizedReservation = {
		...fixture.input.normalizedReservation,
		amount: 589,
	};
	let externalCalls = 0;
	const result = await defaultReconcileArchivedEmail(fixture.input, {
		loadReconciliationReservation: async () => {
			externalCalls += 1;
			return directApiReservation();
		},
		loadReconciliationHotel: async () => {
			externalCalls += 1;
			return activeHotel();
		},
		otaReservationMapper: {
			async reconcileDirectHotelRunnerOwnedEmail() {
				externalCalls += 1;
				return { status: "updated", reservationId: RESERVATION_ID };
			},
		},
	});
	assert.equal(result.status, "needs_review");
	assert.equal(
		result.skipReason,
		"hotelrunner_first_reconciliation_context_invalid"
	);
	assert.equal(externalCalls, 0);
});

test("the default confirmed-empty boundary passes cutoff and proof into creation-only mapper mode", async () => {
	const fixture = defaultReconciliationFixture(
		"confirmed_empty_email_fallback"
	);
	const checkedAt = new Date(START.getTime() + 1_000);
	fixture.input.confirmedEmptyProof = buildConfirmedEmptyProof({
		job: fixture.job,
		lookup: { responseHash: "c".repeat(64) },
		now: checkedAt,
		proofTtlMs: 120_000,
		proofId: "proof-default-boundary",
	});
	fixture.job.negativeLookupProof = fixture.input.confirmedEmptyProof;
	let mapperCalls = 0;
	const result = await defaultReconcileArchivedEmail(fixture.input, {
		clock: () => new Date(checkedAt),
		projectionNotBefore: new Date("2026-08-09T15:00:00.000Z"),
		inspectLocalHotelRunnerStateForReconciliation: async () => ({
			events: [
				{
					_id: EVENT_ID,
					hotelId: HOTEL_ID,
					hotelRunnerReservationId: "legacy-precutoff",
					providerNumber: CONFIRMATION,
					channel: "agoda",
					status: "pending",
					source: "push",
					receivedAt: new Date("2026-08-09T14:00:00.000Z"),
					sourceUpdatedAt: new Date("2026-08-09T14:00:00.000Z"),
				},
			],
			mirrors: [],
			reservations: [],
		}),
		loadReconciliationHotel: async () => activeHotel(),
		otaReservationMapper: {
			async reconcileOtaReservation(normalized, options) {
				mapperCalls += 1;
				assert.equal(normalized.confirmationNumber, CONFIRMATION);
				assert.equal(
					options.hotelRunnerFirstFallbackBoundary.confirmedEmptyProof.proofId,
					"proof-default-boundary"
				);
				return { status: "created", reservationId: RESERVATION_ID };
			},
		},
	});
	assert.equal(result.status, "created");
	assert.equal(mapperCalls, 1);
});

test("the default fallback boundary rechecks current hotel proof and wrong local candidates before writes", async (t) => {
	for (const [name, dependencies] of [
		[
			"hotel ownership changed",
			{
				inspectLocalHotelRunnerStateForReconciliation: async () => ({
					kind: "absent",
				}),
				loadReconciliationHotel: async () =>
					activeHotel({ belongsTo: "6a40b6a1a6efe70450536041" }),
			},
		],
		[
			"wrong direct candidate appeared",
			{
				inspectLocalHotelRunnerStateForReconciliation: async () => ({
					events: [],
					mirrors: [],
					reservations: [
						directApiReservation({ hotelId: OTHER_HOTEL_ID }),
					],
				}),
				loadReconciliationHotel: async () => activeHotel(),
			},
		],
		[
			"hotel activation proof became incomplete",
			{
				inspectLocalHotelRunnerStateForReconciliation: async () => ({
					kind: "absent",
				}),
				loadReconciliationHotel: async () =>
					activeHotel({ xHotelProActive: undefined }),
			},
		],
	]) {
		await t.test(name, async () => {
			const fixture = defaultReconciliationFixture(
				"confirmed_empty_email_fallback"
			);
			const checkedAt = new Date(START.getTime() + 1_000);
			fixture.input.confirmedEmptyProof = buildConfirmedEmptyProof({
				job: fixture.job,
				lookup: { responseHash: "d".repeat(64) },
				now: checkedAt,
				proofTtlMs: 120_000,
				proofId: `proof-${name}`,
			});
			fixture.job.negativeLookupProof = fixture.input.confirmedEmptyProof;
			let mapperCalls = 0;
			const result = await defaultReconcileArchivedEmail(fixture.input, {
				clock: () => new Date(checkedAt),
				...dependencies,
				otaReservationMapper: {
					async reconcileOtaReservation() {
						mapperCalls += 1;
						return { status: "created", reservationId: RESERVATION_ID };
					},
				},
			});
			assert.equal(result.status, "needs_review");
			assert.equal(mapperCalls, 0);
		});
	}
});

test("real coordinator adopts an exact expired fallback marker without a new vendor lookup or write", async () => {
	const originalReservationFind = Reservations.find;
	const originalReservationCreate = Reservations.create;
	const originalReservationUpdateOne = Reservations.updateOne;
	const originalHotelFind = HotelDetails.find;
	let reservation = null;
	let durableJob = null;
	let reservationWrites = 0;
	const testIngressGate = {
		async commitEmailCreation({ authorization, reservationId }) {
			assert.equal(
				authorization.token,
				durableJob.ingressDecision.emailAuthorization.token
			);
			durableJob.ingressDecision.status = "email_committed";
			durableJob.ingressDecision.emailReservationId = reservationId;
			durableJob.ingressDecision.emailCommittedAt = context.clock.now();
			return { committed: true, reservationId };
		},
	};
	const context = harness({
		useDefaultReconcileFallback: true,
		hotelRunnerFirstFallbackIngressGate: testIngressGate,
		lookup: async () => {
			throw new Error("expired crash replay must not depend on HotelRunner");
		},
		loadReservation: async () => reservation,
	});
	await enqueueDefault(context);
	context.clock.advance(DEFAULT_GRACE_MS);
	const firstClaim = await context.coordinator.claimJob();
	assert.ok(firstClaim);
	const checkedAt = context.clock.now();
	const proof = buildConfirmedEmptyProof({
		job: firstClaim,
		lookup: { responseHash: "8".repeat(64) },
		now: checkedAt,
		proofTtlMs: 60_000,
		proofId: "expired-crash-replay-proof",
	});
	firstClaim.negativeLookupProof = proof;
	const markerBoundary = {
		mode: "confirmed_empty_email_fallback",
		fallbackJobId: String(firstClaim._id),
		hotelId: HOTEL_ID,
		provider: "agoda",
		confirmationNumber: CONFIRMATION,
		identityKey: `agoda:${CONFIRMATION}`,
		inboundEmailId: EMAIL_ID,
		inboundEmailHash: firstClaim.inboundEmailHash,
		normalizedReservationHash: firstClaim.normalizedReservationHash,
		resolvedHotelProofHash: firstClaim.resolvedHotelProofHash,
		archiveFingerprint: firstClaim.archiveFingerprint,
		hrIdFingerprint: firstClaim.hrIdFingerprint,
		lookupConfirmationNumber: firstClaim.lookupConfirmationNumber,
		lookupConfirmationHash: firstClaim.lookupConfirmationHash,
		confirmedEmptyProof: proof,
		jobLeaseOwner: firstClaim.leaseOwner,
		jobLeaseToken: firstClaim.leaseToken,
		jobLeaseUntil: firstClaim.leaseUntil,
	};
	const creationAuthorization = buildCreationAuthorization({
		boundary: markerBoundary,
		token: "7".repeat(64),
		authorizedAt: new Date(checkedAt.getTime() + 1_000),
		leaseUntil: firstClaim.leaseUntil,
	});
	assert.ok(creationAuthorization);
	markerBoundary.creationAuthorization = creationAuthorization;
	const marker = buildHotelRunnerFirstFallbackCreationMarker(markerBoundary);
	assert.ok(marker);
	reservation = {
		_id: RESERVATION_ID,
		hotelId: HOTEL_ID,
		belongsTo: OWNER_ID,
		confirmation_number: "9000000999",
		reservation_id: CONFIRMATION,
		otaIdentityKey: `agoda:${CONFIRMATION}`,
		booking_source: "Agoda",
		customer_details: { confirmation_number2: CONFIRMATION },
		supplierData: {
			otaProvider: "agoda",
			otaConfirmationNumber: CONFIRMATION,
			suppliedBookingNo: CONFIRMATION,
			platformConfirmationNumber: CONFIRMATION,
			hotelRunnerFirstFallbackCreation: marker,
		},
	};
	const stored = Array.from(context.jobStore.jobs.values())[0];
	durableJob = stored;
	stored.status = "retry";
	stored.negativeLookupProof = clone(proof);
	stored.ingressDecision = {
		status: "email_authorized",
		emailAuthorization: clone(creationAuthorization),
		emailAuthorizationLeaseUntil: new Date(creationAuthorization.leaseUntil),
	};
	stored.nextAttemptAt = new Date(checkedAt.getTime() + 61_000);
	delete stored.leaseOwner;
	delete stored.leaseToken;
	delete stored.leaseAcquiredAt;
	delete stored.leaseUntil;
	Reservations.find = () => ({
		limit() {
			return this;
		},
		select() {
			return this;
		},
		async exec() {
			return [reservation];
		},
	});
	Reservations.create = async () => {
		reservationWrites += 1;
		throw new Error("expired replay must not create");
	};
	Reservations.updateOne = async () => {
		reservationWrites += 1;
		throw new Error("expired replay must not mutate");
	};
	HotelDetails.find = () => {
		throw new Error("expired marker adoption must stop before mapper hotel lookup");
	};

	try {
		context.clock.advance(61_000);
		const result = await context.coordinator.runOnce();
		assert.equal(result.status, "completed_email_fallback");
		assert.equal(
			result.lastDecision,
			"completed_email_fallback_expired_proof_replay"
		);
		assert.equal(result.reservationMongoId, RESERVATION_ID);
		assert.equal(context.calls.lookup, 0);
		assert.equal(reservationWrites, 0);
		assert.equal(stored.ingressDecision.status, "email_committed");
		assert.equal(stored.ingressDecision.emailReservationId, RESERVATION_ID);
	} finally {
		Reservations.find = originalReservationFind;
		Reservations.create = originalReservationCreate;
		Reservations.updateOne = originalReservationUpdateOne;
		HotelDetails.find = originalHotelFind;
	}
});

test("an exact vendor match is persisted to the API event queue and never projected inline", async () => {
	const context = harness({
		lookup: async () => ({
			reservations: [
				{ id: "40382472", provider_number: CONFIRMATION, channel: "agodaycs5" },
			],
			pages: 1,
			count: 1,
			current_page: 1,
		}),
	});
	await enqueueDefault(context);
	context.clock.advance(DEFAULT_GRACE_MS);
	const result = await context.coordinator.runOnce();
	assert.equal(result.status, "retry");
	assert.equal(result.lastDecision, "hotelrunner_lookup_match_queued_for_projection");
	assert.equal(context.calls.lookup, 1);
	assert.equal(context.calls.persist, 1);
	assert.equal(context.calls.fallback, 0);
	assert.equal(context.calls.api, 0);
	assert.equal(context.markers.length, 1);
	assert.equal(context.markers[0].eventId, EVENT_ID);
	assert.equal(result.hotelRunnerEventOrigin, "targeted_identity_lookup");
	assert.equal(result.hotelRunnerEventId, EVENT_ID);
	assert.ok(result.lookupEventProjectableAt instanceof Date);
	assert.equal(
		TARGETED_LOOKUP_EVENT_MARKER_PATH,
		"result.hotelRunnerFirstFallbackTargetedLookup"
	);
});

test("confirmed-empty lookup creates a bound proof before allowing email fallback", async () => {
	let fallbackInput = null;
	const context = harness({
		reconcileFallback: async (input) => {
			fallbackInput = input;
			return { status: "created", reservationId: RESERVATION_ID };
		},
	});
	await enqueueDefault(context);
	context.clock.advance(DEFAULT_GRACE_MS);
	const result = await context.coordinator.runOnce();
	assert.equal(result.status, "completed_email_fallback");
	assert.equal(context.calls.lookup, 1);
	assert.equal(context.calls.fallback, 1);
	assert.equal(fallbackInput.mode, "confirmed_empty_email_fallback");
	assert.equal(fallbackInput.normalizedReservation.amount, 588);
	assert.equal(fallbackInput.normalizedReservation.netAmountSar, 363.78);
	assert.equal(fallbackInput.confirmedEmptyProof.status, "confirmed_empty");
	assert.equal(fallbackInput.confirmedEmptyProof.resultCount, 0);
	assert.equal(
		fallbackInput.confirmedEmptyProof.archiveFingerprint,
		fallbackInput.archiveFingerprint
	);
	assert.equal(context.finalizations.length, 1);
	assert.equal(context.finalizations[0].status, "completed_email_fallback");
	assert.equal(context.finalizations[0].details.reservationId, RESERVATION_ID);
	assert.equal(result.inboundAuditFinalizationStatus, "completed");
	assert.equal(result.notificationOutboxStatus, "pending");
	assert.equal(context.terminalNotifications.length, 1);
});

test("the exact source-cased OTA code is used for HotelRunner lookup", async () => {
	const sourceConfirmation = "AbC-90210-XyZ";
	const lowerConfirmation = sourceConfirmation.toLowerCase();
	const audit = archivedEmail({
		confirmationNumber: sourceConfirmation,
		normalizedReservation: {
			confirmationNumber: sourceConfirmation,
			reservationId: sourceConfirmation,
		},
	});
	const context = harness({
		audits: new Map([[EMAIL_ID, audit]]),
		expectedLookupConfirmation: sourceConfirmation,
		loadReservation: async (reservationId) => ({
			_id: reservationId,
			hotelId: HOTEL_ID,
			otaIdentityKey: `agoda:${lowerConfirmation}`,
			reservation_id: sourceConfirmation,
			customer_details: { confirmation_number2: sourceConfirmation },
			supplierData: {
				otaProvider: "agoda",
				otaConfirmationNumber: sourceConfirmation,
			},
		}),
	});
	await context.coordinator.enqueueArchivedEmail({
		inboundEmailId: EMAIL_ID,
		hotelId: HOTEL_ID,
		provider: "agoda",
		confirmationNumber: sourceConfirmation,
	});
	context.clock.advance(DEFAULT_GRACE_MS);
	const result = await context.coordinator.runOnce();
	assert.equal(result.status, "completed_email_fallback");
	assert.equal(context.calls.lookup, 1);
});

test("a tampered lookup target cannot query HotelRunner or authorize fallback", async () => {
	const context = harness();
	const queued = await enqueueDefault(context);
	const stored = [...context.jobStore.jobs.values()].find(
		(job) => job._id === queued.job._id
	);
	stored.lookupConfirmationNumber = "different-code";
	context.clock.advance(DEFAULT_GRACE_MS);
	const result = await context.coordinator.runOnce();
	assert.equal(result.status, "needs_review");
	assert.equal(result.lastDecision, "archived_email_integrity_rejected");
	assert.deepEqual(context.calls, {
		lookup: 0,
		persist: 0,
		api: 0,
		fallback: 0,
	});
});

test("a queued job from a different HotelRunner credential fingerprint cannot query or mutate", async () => {
	const context = harness();
	await enqueueDefault(context);
	const stored = [...context.jobStore.jobs.values()][0];
	stored.hrIdFingerprint = "0".repeat(64);
	context.clock.advance(DEFAULT_GRACE_MS);
	const result = await context.coordinator.runOnce();
	assert.equal(result.status, "needs_review");
	assert.equal(
		result.lastDecision,
		"hotelrunner_configuration_identity_changed"
	);
	assert.deepEqual(context.calls, { lookup: 0, persist: 0, api: 0, fallback: 0 });
});

test("owner reassignment after enqueue blocks every lookup and reservation mutation", async () => {
	const context = harness({
		currentHotel: {
			_id: HOTEL_ID,
			belongsTo: OTHER_HOTEL_ID,
			currency: "SAR",
			activateHotel: true,
			xHotelProActive: true,
		},
	});
	await enqueueDefault(context);
	context.clock.advance(DEFAULT_GRACE_MS);
	const result = await context.coordinator.runOnce();
	assert.equal(result.status, "needs_review");
	assert.equal(result.lastDecision, "resolved_hotel_proof_changed");
	assert.deepEqual(context.calls, {
		lookup: 0,
		persist: 0,
		api: 0,
		fallback: 0,
	});
});

test("email fallback terminalizes only after the returned reservation matches hotel and OTA identity", async () => {
	const context = harness({
		loadReservation: async (reservationId) => ({
			_id: reservationId,
			hotelId: OTHER_HOTEL_ID,
			otaIdentityKey: `agoda:${CONFIRMATION}`,
			reservation_id: CONFIRMATION,
		}),
	});
	await enqueueDefault(context);
	context.clock.advance(DEFAULT_GRACE_MS);
	const result = await context.coordinator.runOnce();
	assert.equal(result.status, "needs_review");
	assert.equal(result.lastDecision, "email_fallback_result_identity_conflict");
});

test("creation-only email fallback never accepts an updated result", async () => {
	const context = harness({
		reconcileFallback: async () => ({
			status: "updated",
			reservationId: RESERVATION_ID,
		}),
	});
	await enqueueDefault(context);
	context.clock.advance(DEFAULT_GRACE_MS);
	const result = await context.coordinator.runOnce();
	assert.equal(result.status, "retry");
	assert.equal(result.lastDecision, "processing_error_fail_closed");
	assert.equal(context.terminalNotifications.length, 0);
});

test("terminal audit-finalization uncertainty retries instead of losing the audit link", async () => {
	const context = harness({
		finalizeAudit: async () => {
			const error = new Error("audit database unavailable");
			error.code = "AUDIT_TEMPORARILY_UNAVAILABLE";
			throw error;
		},
	});
	await enqueueDefault(context);
	context.clock.advance(DEFAULT_GRACE_MS);
	const result = await context.coordinator.runOnce();
	assert.equal(result.status, "retry");
	assert.equal(result.lastDecision, "terminal_audit_finalization_retry");
	assert.equal(result.pendingTerminalStatus, "completed_email_fallback");
	assert.equal(context.calls.fallback, 1, "fallback mutation remains idempotent on retry");
	assert.equal(context.finalizations.length, 1);
});

test("integrity finalization replay converges after audit commit and job-CAS crash", async () => {
	const job = {
		_id: "job-integrity-replay",
		inboundEmailId: EMAIL_ID,
		inboundEmailHash: "a".repeat(64),
		hotelId: HOTEL_ID,
		provider: "agoda",
		confirmationNumber: CONFIRMATION,
	};
	const details = {
		decision: "archived_email_integrity_rejected",
		code: "ARCHIVED_EMAIL_HASH_MISMATCH",
		message: "The archived email changed after it was queued.",
		integrityRejected: true,
	};
	const calls = [];
	const InboundModel = {
		updateOne(filter, update) {
			calls.push({ filter: clone(filter), update: clone(update) });
			const firstFinalization = calls.length === 1;
			const replayAwaitingCas = calls.length === 2;
			const exactTerminalProof = calls.length === 3;
			return {
				exec: async () => ({
					matchedCount:
						firstFinalization || exactTerminalProof ? 1 : 0,
					modifiedCount: firstFinalization ? 1 : 0,
				}),
			};
		},
	};

	await defaultFinalizeInboundAudit(
		{ job, status: "needs_review", details, finalizedAt: new Date(START) },
		{ InboundModel }
	);
	await defaultFinalizeInboundAudit(
		{
			job,
			status: "needs_review",
			details: {
				...details,
				code: "ARCHIVED_EMAIL_STATUS_INELIGIBLE",
			},
			finalizedAt: new Date(START.getTime() + 1_000),
		},
		{ InboundModel }
	);

	assert.equal(calls.length, 3);
	assert.deepEqual(calls[1].filter.processingStatus, {
		$in: ["parsed_awaiting_hotelrunner", "awaiting_hotelrunner"],
	});
	assert.equal(calls[2].filter.processingStatus, "needs_review");
	assert.equal(
		calls[2].filter["hotelRunnerFirstFallback.jobId"],
		job._id
	);
	assert.equal(
		calls[2].filter[
			"reconciliation.hotelRunnerFirstFallback.decision"
		],
		"archived_email_integrity_rejected"
	);
	assert.deepEqual(calls[2].update, {
		$set: { "hotelRunnerFirstFallback.status": "needs_review" },
	});
});

test("prepared terminal intent resumes without rerunning mutation after every audit/job crash split", async () => {
	for (const scenario of [
		{ name: "api", expectedStatus: "completed_api" },
		{ name: "fallback", expectedStatus: "completed_email_fallback" },
		{ name: "review", expectedStatus: "needs_review" },
		{ name: "integrity", expectedStatus: "needs_review" },
	]) {
		const context = harness({
			inspect:
				scenario.name === "api"
					? async () => ({
							kind: "api",
							reservationId: RESERVATION_ID,
							eventId: EVENT_ID,
						})
					: undefined,
		});
		const queued = await enqueueDefault(context);
		const stored = [...context.jobStore.jobs.values()].find(
			(job) => job._id === queued.job._id
		);
		if (scenario.name === "review") stored.identityConflict = true;
		if (scenario.name === "integrity") {
			context.audits.get(EMAIL_ID).emailHash = "9".repeat(64);
		}

		const originalUpdateOwned = context.jobStore.updateOwned.bind(
			context.jobStore
		);
		let loseFinalJobCas = true;
		context.jobStore.updateOwned = async (job, update, checkedAt) => {
			if (
				loseFinalJobCas &&
				["completed_api", "completed_email_fallback", "needs_review"].includes(
					update?.$set?.status
				)
			) {
				loseFinalJobCas = false;
				return null;
			}
			return originalUpdateOwned(job, update, checkedAt);
		};

		context.clock.advance(DEFAULT_GRACE_MS);
		assert.equal(await context.coordinator.runOnce(), null, scenario.name);
		assert.equal(stored.status, "processing", scenario.name);
		assert.equal(stored.pendingTerminalStatus, scenario.expectedStatus);
		const mutationCallsAfterCrash = {
			api: context.calls.api,
			fallback: context.calls.fallback,
		};

		context.clock.advance(DEFAULT_LEASE_MS + 1);
		const resumed = await context.coordinator.runOnce();
		assert.equal(resumed.status, scenario.expectedStatus, scenario.name);
		assert.equal(
			Object.hasOwn(resumed, "pendingTerminalStatus"),
			false,
			scenario.name
		);
		assert.deepEqual(
			{ api: context.calls.api, fallback: context.calls.fallback },
			mutationCallsAfterCrash,
			`${scenario.name} mutation must not rerun`
		);
		assert.equal(context.finalizations.length, 2, scenario.name);
	}
});

test("audit-finalization outages cannot exhaust or replace a prepared successful result", async () => {
	let failuresRemaining = 15;
	const context = harness({
		maxAttempts: 3,
		finalizeAudit: async () => {
			if (failuresRemaining > 0) {
				failuresRemaining -= 1;
				throw new Error("synthetic prolonged audit outage");
			}
			return true;
		},
	});
	await enqueueDefault(context);
	context.clock.advance(DEFAULT_GRACE_MS);
	for (let cycle = 0; cycle < 15; cycle += 1) {
		const retry = await context.coordinator.runOnce();
		assert.equal(retry.status, "retry");
		assert.equal(
			retry.pendingTerminalStatus,
			"completed_email_fallback"
		);
		assert.equal(retry.lastDecision, "terminal_audit_finalization_retry");
		assert.equal(retry.attemptCount, 0);
		context.clock.advance(6_000);
	}
	const completed = await context.coordinator.runOnce();
	assert.equal(completed.status, "completed_email_fallback");
	assert.equal(completed.lastDecision, "completed_email_fallback_after_confirmed_empty_lookup");
	assert.equal(context.calls.lookup, 1);
	assert.equal(context.calls.fallback, 1);
	assert.equal(context.finalizations.length, 16);
});

test("max-attempt recovery preserves a prepared success when audit retry CAS is lost", async () => {
	let failAuditOnce = true;
	const context = harness({
		maxAttempts: 3,
		finalizeAudit: async () => {
			if (failAuditOnce) {
				failAuditOnce = false;
				throw new Error("synthetic audit outage at max attempt");
			}
			return true;
		},
	});
	const queued = await enqueueDefault(context);
	const stored = [...context.jobStore.jobs.values()].find(
		(job) => job._id === queued.job._id
	);
	stored.attemptCount = 2;
	const originalUpdateOwned = context.jobStore.updateOwned.bind(
		context.jobStore
	);
	let loseRetryCas = true;
	context.jobStore.updateOwned = async (job, update, checkedAt) => {
		if (loseRetryCas && update?.$set?.status === "retry") {
			loseRetryCas = false;
			return null;
		}
		return originalUpdateOwned(job, update, checkedAt);
	};

	context.clock.advance(DEFAULT_GRACE_MS);
	assert.equal(await context.coordinator.runOnce(), null);
	assert.equal(stored.status, "processing");
	assert.equal(stored.attemptCount, 3);
	assert.equal(stored.pendingTerminalStatus, "completed_email_fallback");
	context.clock.advance(DEFAULT_LEASE_MS + 1);
	const completed = await context.coordinator.runOnce();
	assert.equal(completed.status, "completed_email_fallback");
	assert.equal(
		completed.lastDecision,
		"completed_email_fallback_after_confirmed_empty_lookup"
	);
	assert.equal(context.calls.lookup, 1);
	assert.equal(context.calls.fallback, 1);
});

test("invalid or internally contradictory vendor responses retry without fallback", async () => {
	for (const envelope of [
		{},
		{ reservations: [], pages: 1, total: 2 },
		{
			reservations: [
				{ id: "40382472", provider_number: CONFIRMATION, channel: "unknown-channel" },
			],
			pages: 1,
		},
	]) {
		const context = harness({ lookup: async () => clone(envelope) });
		await enqueueDefault(context);
		context.clock.advance(DEFAULT_GRACE_MS);
		const result = await context.coordinator.runOnce();
		assert.ok(["retry", "needs_review"].includes(result.status));
		assert.equal(context.calls.fallback, 0);
	}
});

test("multiple exact-lookup candidates fail closed into review", async () => {
	const context = harness({
		lookup: async () => ({
			reservations: [
				{ id: "one", provider_number: CONFIRMATION, channel: "agoda" },
				{ id: "two", provider_number: CONFIRMATION, channel: "agoda" },
			],
			pages: 1,
			count: 2,
			current_page: 1,
		}),
	});
	await enqueueDefault(context);
	context.clock.advance(DEFAULT_GRACE_MS);
	const result = await context.coordinator.runOnce();
	assert.equal(result.status, "needs_review");
	assert.equal(result.lastDecision, "hotelrunner_lookup_ambiguous");
	assert.equal(context.calls.fallback, 0);
});

test("a callback observed after lookup but before fallback wins the final local recheck", async () => {
	let inspections = 0;
	const context = harness({
		inspect: async () => {
			inspections += 1;
			return inspections === 1
				? { kind: "absent", code: "absent" }
				: { kind: "api", reservationId: RESERVATION_ID, eventId: EVENT_ID };
		},
	});
	await enqueueDefault(context);
	context.clock.advance(DEFAULT_GRACE_MS);
	const result = await context.coordinator.runOnce();
	assert.equal(result.status, "completed_api");
	assert.equal(context.calls.lookup, 1);
	assert.equal(context.calls.api, 1);
	assert.equal(context.calls.fallback, 0);
});

test("property-wide HotelRunner priority work blocks the vendor lookup", async () => {
	const context = harness({ queueClear: async () => false });
	await enqueueDefault(context);
	context.clock.advance(DEFAULT_GRACE_MS);
	const result = await context.coordinator.runOnce();
	assert.equal(result.status, "retry");
	assert.equal(result.lastDecision, "hotelrunner_priority_queue_not_clear");
	assert.deepEqual(context.calls, { lookup: 0, persist: 0, api: 0, fallback: 0 });
});

test("priority barrier ignores unrelated future retries but includes due and actively leased work", () => {
	const query = buildHotelRunnerPriorityWorkQuery(HOTEL_ID, START);
	assert.equal(query.hotelId, HOTEL_ID);
	const priorityBranches = query.$and[1].$or;
	const retryBranch = priorityBranches.find((branch) =>
		Array.isArray(branch.status?.$in)
	);
	assert.deepEqual(retryBranch.status.$in, ["pending", "retry"]);
	assert.equal(retryBranch.nextAttemptAt.$lte, START);
	const activeProcessing = priorityBranches.find(
		(branch) => branch.status === "processing" && branch.leaseUntil?.$gt
	);
	assert.equal(activeProcessing.leaseUntil.$gt, START);
	assert.equal(
		priorityBranches.some(
			(branch) =>
				branch.status?.$in?.includes("retry") &&
				branch.nextAttemptAt?.$gt !== undefined
		),
		false,
		"future-due retry work must not be a permanent property-wide barrier"
	);
});

test("orphan recovery durably enqueues parsed awaiting audits and skips existing identities", async () => {
	const candidate = {
		_id: EMAIL_ID,
		hotelId: HOTEL_ID,
		provider: "agoda",
		confirmationNumber: CONFIRMATION,
		receivedAt: new Date(START.getTime() - DEFAULT_GRACE_MS),
	};
	const context = harness({
		recoverableAudits: async () => [candidate],
	});
	const first = await context.coordinator.recoverOrphanedArchivedEmails({
		staleBefore: START,
	});
	assert.equal(first.scanned, 1);
	assert.equal(first.enqueued, 1);
	assert.equal(first.held, 0);
	const second = await context.coordinator.recoverOrphanedArchivedEmails({
		staleBefore: START,
	});
	assert.equal(second.enqueued, 0);
	assert.equal(second.alreadyQueued, 1);
});

test("a recovered conflicting archive is finalized needs-review instead of left awaiting", async () => {
	let captured = null;
	const InboundModel = {
		updateOne(filter, update) {
			captured = { filter, update };
			return { exec: async () => ({ matchedCount: 1 }) };
		},
	};
	await defaultMarkRecoveredArchivedEmail(
		{
			candidate: { _id: OTHER_EMAIL_ID, hotelId: HOTEL_ID },
			job: { _id: "job-original" },
			status: "collision",
			markedAt: START,
		},
		{ InboundModel }
	);
	assert.equal(captured.update.$set.processingStatus, "needs_review");
	assert.equal(captured.update.$set.automationAction, "skipped");
	assert.equal(
		captured.update.$set["hotelRunnerFirstFallback.status"],
		"identity_collision"
	);
	assert.equal(
		captured.update.$set.reconciliation.skipReason,
		"hotelrunner_fallback_identity_collision"
	);
});

test("confirmed-empty proof is identity, archive, and expiry bound", () => {
	const identity = buildIdentity({
		hotelId: HOTEL_ID,
		provider: "agoda",
		confirmationNumber: CONFIRMATION,
	});
	const job = {
		...identity,
		lookupConfirmationNumber: CONFIRMATION,
		lookupConfirmationHash: require("crypto")
			.createHash("sha256")
			.update(CONFIRMATION)
			.digest("hex"),
		archiveFingerprint: "d".repeat(64),
		hrIdFingerprint: "f".repeat(64),
		resolvedHotelProofHash: "a".repeat(64),
	};
	const proof = buildConfirmedEmptyProof({
		job,
		lookup: { responseHash: "e".repeat(64) },
		now: START,
		proofTtlMs: 60_000,
		proofId: "proof-one",
	});
	job.negativeLookupProof = proof;
	assert.equal(validConfirmedEmptyProof(job, proof, START), true);
	assert.equal(
		validConfirmedEmptyProof(
			{ ...job, confirmationNumber: "different" },
			proof,
			START
		),
		false
	);
	assert.equal(
		validConfirmedEmptyProof(job, { ...proof, archiveFingerprint: "f".repeat(64) }, START),
		false
	);
	assert.equal(
		validConfirmedEmptyProof(
			{ ...job, lookupConfirmationNumber: "different-code" },
			proof,
			START
		),
		false
	);
	assert.equal(
		validConfirmedEmptyProof(job, proof, new Date(START.getTime() + 60_000)),
		false
	);
	for (const tamperedProof of [
		{ ...proof, proofId: "caller-freshened-proof" },
		{ ...proof, responseHash: "b".repeat(64) },
		{
			...proof,
			expiresAt: new Date(new Date(proof.expiresAt).getTime() + 60_000),
		},
	]) {
		assert.equal(validConfirmedEmptyProof(job, tamperedProof, START), false);
	}
});

test("two workers cannot claim one due identity concurrently", async () => {
	const clock = mutableClock();
	const jobStore = createMemoryJobStore();
	const first = harness({ clock, jobStore, instanceId: "worker-a" });
	const second = harness({ clock, jobStore, instanceId: "worker-b" });
	await enqueueDefault(first);
	clock.advance(DEFAULT_GRACE_MS);
	const claims = await Promise.all([
		first.coordinator.claimJob(),
		second.coordinator.claimJob(),
	]);
	assert.equal(claims.filter(Boolean).length, 1);
	assert.equal(claims.filter(Boolean)[0].attemptCount, 1);
});

test("a crashed worker lease is reclaimable, and its stale CAS cannot finish", async () => {
	const clock = mutableClock();
	const jobStore = createMemoryJobStore();
	const first = harness({ clock, jobStore, instanceId: "worker-a" });
	const second = harness({ clock, jobStore, instanceId: "worker-b" });
	await enqueueDefault(first);
	clock.advance(DEFAULT_GRACE_MS);
	const staleClaim = await first.coordinator.claimJob();
	assert.ok(staleClaim);
	assert.equal(await second.coordinator.claimJob(), null);
	clock.advance(DEFAULT_LEASE_MS + 1);
	const recoveredClaim = await second.coordinator.claimJob();
	assert.ok(recoveredClaim);
	assert.equal(recoveredClaim.leaseOwner, "worker-b");
	assert.equal(recoveredClaim.attemptCount, 2);
	await assert.rejects(
		first.coordinator.processClaimedJob(staleClaim),
		(error) => error.code === "HOTELRUNNER_FALLBACK_LEASE_LOST"
	);
});

test("bounded retries become needs_review and never silently fall back", async () => {
	const context = harness({ maxAttempts: 3 });
	await enqueueDefault(context);
	const stored = [...context.jobStore.jobs.values()][0];
	stored.attemptCount = 3;
	stored.nextAttemptAt = new Date(START);
	context.clock.advance(DEFAULT_GRACE_MS);
	const result = await context.coordinator.runOnce();
	assert.equal(result.status, "needs_review");
	assert.equal(result.lastDecision, "retry_exhausted");
	assert.equal(context.calls.fallback, 0);
});

test("local classifier treats ambiguity and blocked HotelRunner evidence as review", () => {
	const identity = buildIdentity({
		hotelId: HOTEL_ID,
		provider: "agoda",
		confirmationNumber: CONFIRMATION,
	});
	assert.deepEqual(
		classifyLocalHotelRunnerState(
			{
				events: [
					{
						hotelId: HOTEL_ID,
						providerNumber: CONFIRMATION,
						channel: "agoda",
						hotelRunnerReservationId: "one",
						status: "pending",
					},
					{
						hotelId: HOTEL_ID,
						providerNumber: CONFIRMATION,
						channel: "agoda",
						hotelRunnerReservationId: "two",
						status: "pending",
					},
				],
				mirrors: [],
				reservations: [],
			},
			identity
		).kind,
		"needs_review"
	);
	assert.equal(
		classifyLocalHotelRunnerState(
			{
				events: [
					{
						hotelId: HOTEL_ID,
						providerNumber: CONFIRMATION,
						channel: "agoda",
						hotelRunnerReservationId: "one",
						status: "quarantined",
					},
				],
				mirrors: [],
				reservations: [],
			},
			identity
		).kind,
		"needs_review"
	);
	for (const [label, event] of [
		["failed", { status: "failed" }],
		["quarantined", { status: "quarantined" }],
		["identity conflict", { status: "pending", channel: "booking" }],
		[
			"manual mapping",
			{
				status: "needs_mapping",
				result: { code: "hotelrunner_room_mapping_required" },
			},
		],
		[
			"integrity conflict",
			{
				status: "needs_mapping",
				integrityConflict: true,
				result: { code: "hotelrunner_room_mapping_stale" },
			},
		],
	]) {
		assert.equal(
			classifyLocalHotelRunnerState(
				{
					events: [
						{
							hotelId: HOTEL_ID,
							providerNumber: CONFIRMATION,
							channel: "agoda",
							hotelRunnerReservationId: "one",
							...event,
						},
					],
					mirrors: [],
					reservations: [],
				},
				identity
			).kind,
			"needs_review",
			label
		);
	}
	assert.equal(
		classifyLocalHotelRunnerState(
			{
				events: [],
				mirrors: [
					{
						hotelId: HOTEL_ID,
						providerNumber: CONFIRMATION,
						channel: "agoda",
						hotelRunnerReservationId: "one",
						projectionStatus: "pending",
						identityConflict: true,
					},
				],
				reservations: [],
			},
			identity
		).kind,
		"needs_review"
	);
});

function inventoryAttentionFixture() {
	const mirrorId = "6a789cf2f77fb5bdaf73b0b4";
	return {
		events: [
			{
				_id: EVENT_ID,
				hotelId: HOTEL_ID,
				providerNumber: CONFIRMATION,
				channel: "agoda",
				hotelRunnerReservationId: "one",
				status: "attention",
				reservationMongoId: RESERVATION_ID,
				mirrorId,
				integrityReason: "",
				integrityConflict: false,
				errorCode: "",
				errorMessage: "",
				result: {
					status: "created",
					inventoryIssueCount: 1,
					missingInvCodes: [],
					staleInvCodes: [],
					inventorySummary: {
						overbooked: true,
						issueCount: 1,
						issues: [{ code: "inventory_overbook" }],
					},
					commercialEvidenceStale: false,
					attentionCode: "",
					integrityConflict: false,
				},
			},
		],
		mirrors: [
			{
				_id: mirrorId,
				hotelId: HOTEL_ID,
				providerNumber: CONFIRMATION,
				channel: "agoda",
				hotelRunnerReservationId: "one",
				reservationMongoId: RESERVATION_ID,
				projectionStatus: "created",
				identityConflict: false,
				lastErrorCode: "",
				lastErrorMessage: "",
			},
		],
		reservations: [
			{
				_id: RESERVATION_ID,
				hotelId: HOTEL_ID,
				otaIdentityKey: `agoda:${CONFIRMATION}`,
				reservation_id: CONFIRMATION,
				supplierData: {
					otaProvider: "agoda",
					suppliedBookingNo: CONFIRMATION,
					otaAutomationPipeline: "hotelrunner_background_worker",
					otaSourceAuthority: 4,
					hotelRunner: {
						transport: "hotelrunner_api",
						reservationId: "one",
						providerNumber: CONFIRMATION,
						channel: "agoda",
					},
				},
			},
		],
	};
}

test("local classifier accepts only a fully linked inventory attention projection as API-complete", () => {
	const identity = buildIdentity({
		hotelId: HOTEL_ID,
		provider: "agoda",
		confirmationNumber: CONFIRMATION,
	});
	assert.deepEqual(classifyLocalHotelRunnerState(inventoryAttentionFixture(), identity), {
		kind: "api",
		code: "direct_api_reservation_found",
		reservationId: RESERVATION_ID,
		eventId: EVENT_ID,
		mirrorId: "6a789cf2f77fb5bdaf73b0b4",
	});
});

test("local classifier rejects commercial, integrity, and unknown attention states", () => {
	const identity = buildIdentity({
		hotelId: HOTEL_ID,
		provider: "agoda",
		confirmationNumber: CONFIRMATION,
	});
	for (const [label, mutate] of [
		[
			"commercial evidence stale",
			(raw) => {
				raw.events[0].result.commercialEvidenceStale = true;
			},
		],
		[
			"commercial attention code",
			(raw) => {
				raw.events[0].result.attentionCode =
					"hotelrunner_commercial_evidence_stale";
			},
		],
		[
			"event error code",
			(raw) => {
				raw.events[0].errorCode = "hotelrunner_projection_warning";
			},
		],
		[
			"event error message",
			(raw) => {
				raw.events[0].errorMessage = "unexpected projection warning";
			},
		],
		[
			"integrity conflict",
			(raw) => {
				raw.events[0].integrityConflict = true;
			},
		],
		[
			"result integrity conflict",
			(raw) => {
				raw.events[0].result.integrityConflict = true;
			},
		],
		[
			"mirror identity conflict",
			(raw) => {
				raw.mirrors[0].identityConflict = true;
			},
		],
		[
			"mirror error message",
			(raw) => {
				raw.mirrors[0].lastErrorMessage = "unexpected mirror warning";
			},
		],
		[
			"unknown attention",
			(raw) => {
				raw.events[0].result.inventorySummary.issues[0].code = "unknown";
			},
		],
		[
			"inventory summary count mismatch",
			(raw) => {
				raw.events[0].result.inventorySummary.issueCount = 2;
			},
		],
		[
			"string inventory issue count",
			(raw) => {
				raw.events[0].result.inventoryIssueCount = "1";
			},
		],
		[
			"boolean summary issue count",
			(raw) => {
				raw.events[0].result.inventorySummary.issueCount = true;
			},
		],
		[
			"missing inventory code remains",
			(raw) => {
				raw.events[0].result.missingInvCodes = ["INV-1"];
			},
		],
		[
			"stale inventory code remains",
			(raw) => {
				raw.events[0].result.staleInvCodes = ["INV-1"];
			},
		],
	]) {
		const raw = inventoryAttentionFixture();
		mutate(raw);
		const result = classifyLocalHotelRunnerState(raw, identity);
		assert.equal(result.kind, "needs_review", label);
		assert.equal(result.code, "hotelrunner_local_record_blocked", label);
	}
});

test("local classifier rejects inventory attention with wrong or missing links", () => {
	const identity = buildIdentity({
		hotelId: HOTEL_ID,
		provider: "agoda",
		confirmationNumber: CONFIRMATION,
	});
	for (const [label, mutate] of [
		[
			"missing event reservation link",
			(raw) => {
				raw.events[0].reservationMongoId = null;
			},
		],
		[
			"wrong event mirror link",
			(raw) => {
				raw.events[0].mirrorId = "6a789cf2f77fb5bdaf73b0b5";
			},
		],
		[
			"wrong mirror reservation link",
			(raw) => {
				raw.mirrors[0].reservationMongoId = "6a789cea66c058f4ab621ec0";
			},
		],
		[
			"wrong PMS HotelRunner reservation link",
			(raw) => {
				raw.reservations[0].supplierData.hotelRunner.reservationId = "two";
			},
		],
		[
			"missing mirror",
			(raw) => {
				raw.mirrors = [];
			},
		],
		[
			"missing direct reservation",
			(raw) => {
				raw.reservations = [];
			},
		],
		[
			"duplicate qualifying attention event",
			(raw) => {
				raw.events.push({
					...raw.events[0],
					_id: "6a789cf2f77fb5bdaf73b0b6",
				});
			},
		],
	]) {
		const raw = inventoryAttentionFixture();
		mutate(raw);
		const result = classifyLocalHotelRunnerState(raw, identity);
		assert.equal(result.kind, "needs_review", label);
		assert.equal(result.code, "hotelrunner_local_record_blocked", label);
	}
});

test("default local inspector selects every diagnostic required by inventory-attention classification", async () => {
	const selections = [];
	const createModel = (name) => ({
		find() {
			return {
				select(value) {
					selections.push({ name, value });
					return this;
				},
				sort() {
					return this;
				},
				limit() {
					return this;
				},
				lean() {
					return this;
				},
				async exec() {
					return [];
				},
			};
		},
	});
	const identity = buildIdentity({
		hotelId: HOTEL_ID,
		provider: "agoda",
		confirmationNumber: CONFIRMATION,
	});

	await defaultInspectLocalHotelRunnerState(identity, {
		EventModel: createModel("event"),
		MirrorModel: createModel("mirror"),
		ReservationModel: createModel("reservation"),
	});

	const eventSelection = selections.find(({ name }) => name === "event")?.value;
	const mirrorSelection = selections.find(({ name }) => name === "mirror")?.value;
	assert.match(eventSelection, /(?:^|\s)errorMessage(?:\s|$)/);
	assert.match(mirrorSelection, /(?:^|\s)lastErrorMessage(?:\s|$)/);
});

test("local classifier keeps exact stale-mapping event and mirror evidence pending", () => {
	const identity = buildIdentity({
		hotelId: HOTEL_ID,
		provider: "agoda",
		confirmationNumber: CONFIRMATION,
	});
	for (const [kind, raw] of [
		[
			"event",
			{
				events: [
					{
						_id: EVENT_ID,
						hotelId: HOTEL_ID,
						providerNumber: CONFIRMATION,
						channel: "agoda",
						hotelRunnerReservationId: "one",
						status: "needs_mapping",
						errorCode: "hotelrunner_room_mapping_stale",
						result: { code: "hotelrunner_room_mapping_stale" },
					},
				],
				mirrors: [],
				reservations: [],
			},
		],
		[
			"mirror",
			{
				events: [],
				mirrors: [
					{
						_id: "6a789cf2f77fb5bdaf73b0b4",
						hotelId: HOTEL_ID,
						providerNumber: CONFIRMATION,
						channel: "agoda",
						hotelRunnerReservationId: "one",
						projectionStatus: "needs_mapping",
						lastErrorCode: "hotelrunner_room_mapping_stale",
					},
				],
				reservations: [],
			},
		],
	]) {
		const result = classifyLocalHotelRunnerState(raw, identity);
		assert.equal(result.kind, "pending", kind);
		assert.equal(result.code, "hotelrunner_mapping_pending", kind);
	}
});

test("local classifier reserves only the exact safe failed currency wait for recovery", () => {
	const identity = buildIdentity({
		hotelId: HOTEL_ID,
		provider: "agoda",
		confirmationNumber: CONFIRMATION,
	});
	const classify = (event) =>
		classifyLocalHotelRunnerState(
			{
				events: [
					{
						_id: EVENT_ID,
						hotelId: HOTEL_ID,
						providerNumber: CONFIRMATION,
						channel: "agoda",
						hotelRunnerReservationId: "one",
						source: "push",
						status: "failed",
						...event,
					},
				],
				mirrors: [],
				reservations: [],
			},
			identity
		);

	assert.deepEqual(
		classify({
			errorCode: "hotelrunner_currency_waiting_for_email_bridge",
		}),
		{
			kind: "pending",
			code: "hotelrunner_late_evidence_pending",
			eventId: EVENT_ID,
			eventSource: "push",
			lookupEventProjectable: true,
		}
	);
	for (const [label, event] of [
		["other failure", { errorCode: "hotelrunner_reservation_cas_conflict" }],
		[
			"integrity reason",
			{
				errorCode: "hotelrunner_currency_waiting_for_email_bridge",
				integrityReason: "message_uid_payload_conflict",
			},
		],
		[
			"integrity conflict",
			{
				errorCode: "hotelrunner_currency_waiting_for_email_bridge",
				integrityConflict: true,
			},
		],
		[
			"active lease",
			{
				errorCode: "hotelrunner_currency_waiting_for_email_bridge",
				leaseOwner: "another-worker",
				leaseUntil: new Date("2026-08-10T17:00:00.000Z"),
			},
		],
		[
			"stale lease residue",
			{
				errorCode: "hotelrunner_currency_waiting_for_email_bridge",
				leaseOwner: "",
				leaseUntil: new Date("2026-08-10T15:00:00.000Z"),
			},
		],
	]) {
		const result = classify(event);
		assert.equal(result.kind, "needs_review", label);
		assert.equal(result.code, "hotelrunner_local_record_blocked", label);
	}
});

test("local classifier requires matching event error and result codes before treating mapping as recoverable", () => {
	const identity = buildIdentity({
		hotelId: HOTEL_ID,
		provider: "agoda",
		confirmationNumber: CONFIRMATION,
	});
	for (const [label, evidence] of [
		[
			"missing event error code",
			{ result: { code: "hotelrunner_room_mapping_stale" } },
		],
		[
			"missing projection result code",
			{ errorCode: "hotelrunner_room_mapping_stale", result: {} },
		],
		[
			"contradictory event error code",
			{
				errorCode: "hotelrunner_room_mapping_required",
				result: { code: "hotelrunner_room_mapping_stale" },
			},
		],
	]) {
		const result = classifyLocalHotelRunnerState(
			{
				events: [
					{
						_id: EVENT_ID,
						hotelId: HOTEL_ID,
						providerNumber: CONFIRMATION,
						channel: "agoda",
						hotelRunnerReservationId: "one",
						status: "needs_mapping",
						...evidence,
					},
				],
				mirrors: [],
				reservations: [],
			},
			identity
		);
		assert.equal(result.kind, "needs_review", label);
		assert.equal(result.code, "hotelrunner_local_record_blocked", label);
	}
});

test("lookup classifier never calls an empty, malformed, or mismatched result exact", () => {
	const identity = buildIdentity({
		hotelId: HOTEL_ID,
		provider: "agoda",
		confirmationNumber: CONFIRMATION,
	});
	const normalize = (row) => ({
		issues: [],
		hotelRunnerReservationId: row.id,
		providerNumber: row.provider_number,
		channel: row.channel,
	});
	assert.equal(
		classifyHotelRunnerLookupEnvelope(
			{ reservations: [], pages: 1, count: 0, current_page: 1 },
			identity,
			{ normalizeReservation: normalize, checkedAt: START }
		).kind,
		"empty"
	);
	assert.equal(
		classifyHotelRunnerLookupEnvelope(
			{ reservations: [] },
			identity,
			{ normalizeReservation: normalize, checkedAt: START }
		).kind,
		"uncertain",
		"an empty array without HotelRunner's documented pagination proof is not absence"
	);
	assert.equal(
		classifyHotelRunnerLookupEnvelope(
			{
				reservations: [
					{ id: "one", provider_number: "different", channel: "agoda" },
				],
				pages: 1,
				count: 1,
				current_page: 1,
			},
			identity,
			{ normalizeReservation: normalize, checkedAt: START }
		).kind,
		"ambiguous"
	);
	assert.equal(
		classifyHotelRunnerLookupEnvelope({}, identity, {
			normalizeReservation: normalize,
			checkedAt: START,
		}).kind,
		"uncertain"
	);
});
