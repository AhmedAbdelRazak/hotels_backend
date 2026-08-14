/** @format */

"use strict";

process.env.SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "SG.test";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
	archiveAndEnqueueHotelRunnerFirstInbound,
	duplicateBlockingEmailStatuses,
	hotelRunnerFirstPreliminaryGate,
	resolveHotelRunnerFirstInboundEligibility,
} = require("../controllers/otaInbound");

const HOTEL_ID = "64b000000000000000000101";
const OWNER_ID = "64b000000000000000000102";
const INBOUND_ID = "64b000000000000000000103";
const JOB_ID = "64b000000000000000000104";

const config = Object.freeze({
	integrationEnabled: true,
	configured: true,
	projectionEnabled: true,
	hotelId: HOTEL_ID,
	hrIdFingerprint: "a".repeat(64),
	otaEmailFallbackGraceMs: 180_000,
	otaEmailFallbackLeaseMs: 300_000,
	otaEmailFallbackProofTtlMs: 120_000,
	otaEmailFallbackMaxAttempts: 12,
});

const senderAuthentication = Object.freeze({
	authenticatedAligned: true,
	trustedProvider: "agoda",
	method: "dkim",
});

const makeInboundRecord = (overrides = {}) => ({
	_id: INBOUND_ID,
	emailHash: "b".repeat(64),
	dedupeKey: "mid:durable-claim",
	senderAuthentication,
	...overrides,
});

const makeNormalized = (overrides = {}) => ({
	inboundEmailId: INBOUND_ID,
	provider: "agoda",
	providerLabel: "Agoda",
	trustedTransportProvider: "agoda",
	sourceSenderTrusted: true,
	sourceSenderAuthenticated: true,
	senderAuthentication,
	intent: "new_reservation",
	eventType: "new",
	confirmationNumber: "2039878308",
	reservationId: "2039878308",
	hotelName: "Zad Ajyad",
	roomName: "Double Room",
	amount: 588,
	currency: "SAR",
	totalAmountSar: 588,
	paymentCollectionModel: "ota_collect",
	sourcePresence: {
		confirmationNumber: true,
		reservationId: true,
		hotelName: true,
	},
	warnings: [],
	errors: [],
	...overrides,
});

test("master-disabled mode bypasses HotelRunner-first routing for direct OTA email", () => {
	const result = hotelRunnerFirstPreliminaryGate({
		normalized: makeNormalized(),
		inboundRecord: makeInboundRecord(),
		config: {
			...config,
			integrationEnabled: false,
			configured: false,
			projectionEnabled: false,
		},
	});
	assert.deepEqual(result, {
		eligible: false,
		reason: "hotelrunner_integration_disabled",
	});
});

const hotelRunnerAuthentication = Object.freeze({
	authenticatedAligned: true,
	trustedProvider: "hotelrunner",
	method: "dkim",
});

const makeHotelRunnerRelayNormalized = (overrides = {}) => ({
	...makeNormalized(),
	trustedTransportProvider: "hotelrunner",
	senderAuthentication: hotelRunnerAuthentication,
	hotelRunnerCommercialSourceProviders: ["agoda"],
	...overrides,
});

test("master-disabled mode keeps every authenticated HotelRunner lifecycle audit-only", () => {
	for (const [name, lifecycle] of [
		["new", {}],
		["not reservation", { intent: "not_reservation", eventType: "unknown" }],
		[
			"cancelled",
			{
				intent: "reservation_status",
				eventType: "cancelled",
				statusToApply: "cancelled",
			},
		],
		[
			"status",
			{
				intent: "reservation_status",
				eventType: "status",
				statusToApply: "confirmed",
			},
		],
	]) {
		const normalized = makeHotelRunnerRelayNormalized(lifecycle);
		const result = hotelRunnerFirstPreliminaryGate({
			normalized,
			inboundRecord: makeInboundRecord({
				senderAuthentication: hotelRunnerAuthentication,
			}),
			config: {
				...config,
				integrationEnabled: false,
				configured: false,
				projectionEnabled: false,
			},
		});
		assert.equal(result.eligible, true, name);
		assert.equal(result.provider, "agoda", name);
		assert.equal(
			result.handlingMode,
			"hotelrunner_relay_audit_only",
			name
		);
		assert.equal(result.queueAvailable, false, name);
		assert.equal(result.normalizedReservation, normalized, name);
	}
});

const activeHotel = Object.freeze({
	_id: HOTEL_ID,
	belongsTo: OWNER_ID,
	hotelName: "Zad Ajyad",
	activateHotel: true,
	xHotelProActive: true,
});

const orchestration = Object.freeze({
	emailContext: { forwarded: false },
	decision: { usedAI: false, skipped: true },
	safeSnippet: "Authenticated Agoda reservation",
});

test("eligible direct OTA email persists its complete audit before queue insertion and never invokes inline reconciliation", async () => {
	const events = [];
	let archivedDocument = null;
	let inlineReconcileCalls = 0;
	const inboundRecord = makeInboundRecord();
	const normalized = makeNormalized();
	const result = await archiveAndEnqueueHotelRunnerFirstInbound(
		{
			inboundRecord,
			email: { subject: "Agoda booking", text: "Reservation details" },
			normalized,
			orchestration,
			config,
		},
		{
			resolveHotelDetails: async () => {
				events.push("resolve");
				return activeHotel;
			},
			persistAudit: async (id, update) => {
				events.push("persist");
				assert.equal(String(id), INBOUND_ID);
				archivedDocument = { ...inboundRecord, ...update };
				return archivedDocument;
			},
			enqueueArchivedEmail: async (input) => {
				events.push("enqueue");
				assert.equal(events.indexOf("persist") < events.indexOf("enqueue"), true);
				assert.equal(archivedDocument.processingStatus, "awaiting_hotelrunner");
				assert.equal(archivedDocument.hotelId, HOTEL_ID);
				assert.equal(archivedDocument.normalizedReservation, normalized);
				assert.equal(archivedDocument.emailHash, "b".repeat(64));
				assert.equal(
					archivedDocument.senderAuthentication.authenticatedAligned,
					true
				);
				assert.deepEqual(input, {
					inboundEmailId: INBOUND_ID,
					hotelId: HOTEL_ID,
					provider: "agoda",
					confirmationNumber: "2039878308",
				});
				return { job: { _id: JOB_ID }, queued: true, collision: false };
			},
			markAudit: async (_id, fields) => {
				events.push("mark");
				return { ...archivedDocument, ...fields };
			},
			reconcileOtaReservation: async () => {
				inlineReconcileCalls += 1;
				throw new Error("eligible email must not reach inline mapper");
			},
		}
	);

	assert.equal(result.handled, true);
	assert.equal(result.enqueueError, undefined);
	assert.equal(result.record["hotelRunnerFirstFallback.status"], "enqueued");
	assert.deepEqual(events, ["resolve", "persist", "enqueue", "mark"]);
	assert.equal(inlineReconcileCalls, 0);
});

test("authenticated HotelRunner relay is archived for review without mapper or coordinator access", async () => {
	const events = [];
	let archived = null;
	let enqueueCalls = 0;
	let inlineReconcileCalls = 0;
	const normalized = makeHotelRunnerRelayNormalized();
	const result = await archiveAndEnqueueHotelRunnerFirstInbound(
		{
			inboundRecord: makeInboundRecord({
				senderAuthentication: hotelRunnerAuthentication,
			}),
			email: { subject: "HotelRunner relay", text: "Agoda reservation" },
			normalized,
			orchestration,
			config,
		},
		{
			resolveHotelDetails: async () => {
				events.push("resolve");
				return activeHotel;
			},
			persistAudit: async (_id, update) => {
				events.push("persist_audit_only");
				archived = { ...makeInboundRecord(), ...update, _id: INBOUND_ID };
				return archived;
			},
			enqueueArchivedEmail: async () => {
				enqueueCalls += 1;
				throw new Error("relay must never enter the identity queue");
			},
			reconcileOtaReservation: async () => {
				inlineReconcileCalls += 1;
			},
		}
	);

	assert.equal(result.handled, true);
	assert.equal(result.relayAuditOnly, true);
	assert.equal(result.queuedResult, null);
	assert.equal(result.reconciliation.status, "needs_review");
	assert.equal(
		result.reconciliation.skipReason,
		"hotelrunner_relay_audit_only"
	);
	assert.equal(
		archived.processingStatus,
		"hotelrunner_relay_audit_only"
	);
	assert.equal(
		archived.hotelRunnerFirstFallback.status,
		"hotelrunner_relay_audit_only"
	);
	assert.equal(archived.hotelRunnerFirstFallback.jobId, null);
	assert.equal(enqueueCalls, 0);
	assert.equal(inlineReconcileCalls, 0);
	assert.deepEqual(events, ["resolve", "persist_audit_only"]);
});

test("relay and direct OTA arrival order cannot collide because only direct mail owns a job", async () => {
	for (const order of ["relay_first", "direct_first"]) {
		const enqueued = [];
		let sequence = 0;
		const persistAudit = async (_id, update) => ({
			...makeInboundRecord(),
			...update,
			_id: `64b000000000000000000${String(10 + sequence++).padStart(3, "0")}`,
		});
		const enqueueArchivedEmail = async (input) => {
			enqueued.push(input);
			return { job: { _id: JOB_ID }, queued: true, collision: false };
		};
		const markAudit = async (id, fields) => ({ _id: id, ...fields });
		const run = (relay) =>
			archiveAndEnqueueHotelRunnerFirstInbound(
				{
					inboundRecord: makeInboundRecord({
						_id: `64b000000000000000000${relay ? "301" : "302"}`,
						senderAuthentication: relay
							? hotelRunnerAuthentication
							: senderAuthentication,
					}),
					email: {},
					normalized: relay
						? makeHotelRunnerRelayNormalized()
						: makeNormalized(),
					orchestration,
					config,
				},
				{
					resolveHotelDetails: async () => activeHotel,
					persistAudit,
					enqueueArchivedEmail,
					markAudit,
				}
			);
		const results =
			order === "relay_first"
				? [await run(true), await run(false)]
				: [await run(false), await run(true)];
		assert.equal(results.filter((result) => result.relayAuditOnly).length, 1, order);
		assert.equal(results.some((result) => result.collision === true), false, order);
		assert.equal(enqueued.length, 1, order);
		assert.equal(enqueued[0].provider, "agoda", order);
		assert.equal(
			Object.prototype.hasOwnProperty.call(enqueued[0], "transportMode"),
			false,
			order
		);
	}
});

test("only authentication failure makes HotelRunner transport ineligible; incomplete relay facts stay audit-only", () => {
	for (const [name, normalized, authentication, expectedEligible] of [
		[
			"unauthenticated",
			makeHotelRunnerRelayNormalized({ sourceSenderAuthenticated: false }),
			hotelRunnerAuthentication,
			false,
		],
		[
			"generic",
			makeHotelRunnerRelayNormalized({
				provider: "hotelrunner",
				hotelRunnerCommercialSourceProviders: [],
			}),
			hotelRunnerAuthentication,
			true,
		],
		[
			"ambiguous provider",
			makeHotelRunnerRelayNormalized({
				hotelRunnerCommercialSourceProviders: ["agoda", "booking"],
			}),
			hotelRunnerAuthentication,
			true,
		],
		[
			"conflicting source",
			makeHotelRunnerRelayNormalized({ hotelRunnerBookingSourceConflict: true }),
			hotelRunnerAuthentication,
			true,
		],
		[
			"wrong authenticated provider",
			makeHotelRunnerRelayNormalized(),
			senderAuthentication,
			false,
		],
	]) {
		const result = hotelRunnerFirstPreliminaryGate({
			normalized,
			inboundRecord: makeInboundRecord({
				senderAuthentication: authentication,
			}),
			config,
		});
		assert.equal(result.eligible, expectedEligible, name);
		if (expectedEligible) {
			assert.equal(result.provider, "hotelrunner", name);
			assert.equal(result.handlingMode, "hotelrunner_relay_audit_only", name);
		}
	}
});

test("a single explicit embedded Trip provider is recognized even when the relay parser retains the HotelRunner namespace", () => {
	const result = hotelRunnerFirstPreliminaryGate({
		normalized: makeHotelRunnerRelayNormalized({
			provider: "hotelrunner",
			providerLabel: "HotelRunner",
			hotelRunnerCommercialSourceProviders: ["trip"],
		}),
		inboundRecord: makeInboundRecord({
			senderAuthentication: hotelRunnerAuthentication,
		}),
		config,
	});
	assert.equal(result.eligible, true);
	assert.equal(result.provider, "trip");
	assert.equal(result.handlingMode, "hotelrunner_relay_audit_only");
});

test("HotelRunner-first preliminary gate requires exact auth, direct provider, source identity, and NEW lifecycle", () => {
	const inboundRecord = makeInboundRecord();
	for (const [name, normalized, currentConfig] of [
		[
			"unauthenticated",
			makeNormalized({ sourceSenderAuthenticated: false }),
			config,
		],
		[
			"provider mismatch",
			makeNormalized({ trustedTransportProvider: "booking" }),
			config,
		],
		[
			"not new",
			makeNormalized({ intent: "reservation_update", eventType: "modified" }),
			config,
		],
		[
			"confirmation inferred",
			makeNormalized({
				sourcePresence: { hotelName: true },
			}),
			config,
		],
		[
			"hotel inferred",
			makeNormalized({
				sourcePresence: { confirmationNumber: true, reservationId: true },
			}),
			config,
		],
	]) {
		assert.equal(
			hotelRunnerFirstPreliminaryGate({
				normalized,
				inboundRecord,
				config: currentConfig,
			}).eligible,
			false,
			name
		);
	}
	const unavailable = hotelRunnerFirstPreliminaryGate({
		normalized: makeNormalized(),
		inboundRecord,
		config: { ...config, configured: false, projectionEnabled: false },
	});
	assert.equal(unavailable.eligible, true);
	assert.equal(unavailable.queueAvailable, false);
	assert.equal(
		unavailable.queueUnavailableReason,
		"hotelrunner_projection_unavailable"
	);
});

test("only the exact configured active HotelRunner property is eligible", async () => {
	const base = { normalized: makeNormalized(), inboundRecord: makeInboundRecord(), config };
	const different = await resolveHotelRunnerFirstInboundEligibility(base, {
		resolveHotelDetails: async () => ({
			...activeHotel,
			_id: "64b000000000000000000199",
		}),
	});
	assert.equal(different.eligible, false);
	assert.equal(different.reason, "different_hotelrunner_property");

	for (const hotel of [
		{ ...activeHotel, activateHotel: false },
		{ ...activeHotel, xHotelProActive: false },
		{ ...activeHotel, belongsTo: null },
	]) {
		const inactive = await resolveHotelRunnerFirstInboundEligibility(base, {
			resolveHotelDetails: async () => hotel,
		});
		assert.equal(inactive.eligible, false);
		assert.equal(inactive.reason, "hotelrunner_property_not_active");
	}

	const eligible = await resolveHotelRunnerFirstInboundEligibility(base, {
		resolveHotelDetails: async () => activeHotel,
	});
	assert.equal(eligible.eligible, true);
	assert.equal(eligible.provider, "agoda");
});

test("ineligible inbound remains on the existing inline path without audit or queue mutation", async () => {
	let writes = 0;
	const result = await archiveAndEnqueueHotelRunnerFirstInbound(
		{
			inboundRecord: makeInboundRecord(),
			email: {},
			normalized: makeNormalized({
				intent: "reservation_update",
				eventType: "modified",
			}),
			orchestration,
			config,
		},
		{
			resolveHotelDetails: async () => {
				throw new Error("ineligible transport must not resolve a queue property");
			},
			persistAudit: async () => {
				writes += 1;
			},
			enqueueArchivedEmail: async () => {
				writes += 1;
			},
		}
	);
	assert.equal(result.handled, false);
	assert.equal(writes, 0);
});

test("configured HotelRunner property holds direct OTA email when projection is unavailable", async () => {
	const inboundRecord = makeInboundRecord();
	let archived = null;
	let enqueueCalls = 0;
	const unavailableConfig = {
		...config,
		configured: false,
		projectionEnabled: false,
	};
	const result = await archiveAndEnqueueHotelRunnerFirstInbound(
		{
			inboundRecord,
			email: { subject: "Agoda booking", text: "Reservation details" },
			normalized: makeNormalized(),
			orchestration,
			config: unavailableConfig,
		},
		{
			resolveHotelDetails: async () => activeHotel,
			persistAudit: async (_id, update) => {
				archived = { ...inboundRecord, ...update };
				return archived;
			},
			enqueueArchivedEmail: async () => {
				enqueueCalls += 1;
			},
		}
	);

	assert.equal(result.handled, true);
	assert.equal(result.eligibility.queueAvailable, false);
	assert.equal(result.enqueueError?.retryable, true);
	assert.equal(
		result.errorCode,
		"HOTELRUNNER_FIRST_PROJECTION_UNAVAILABLE"
	);
	assert.equal(enqueueCalls, 0);
	assert.equal(archived.processingStatus, "awaiting_hotelrunner");
	assert.equal(archived.hotelRunnerFirstFallback.status, "recovery_pending");
	assert.equal(archived.reservationMongoId, null);
});

test("enqueue failure leaves the durable archive and dedupe claim recoverable and signals retry", async () => {
	const inboundRecord = makeInboundRecord();
	let archived = null;
	let marker = null;
	const queueError = new Error("synthetic queue outage");
	queueError.code = "HOTELRUNNER_FALLBACK_ENQUEUE_FAILED";
	queueError.retryable = true;
	const result = await archiveAndEnqueueHotelRunnerFirstInbound(
		{
			inboundRecord,
			email: {},
			normalized: makeNormalized(),
			orchestration,
			config,
		},
		{
			resolveHotelDetails: async () => activeHotel,
			persistAudit: async (_id, update) => {
				archived = { ...inboundRecord, ...update };
				return archived;
			},
			enqueueArchivedEmail: async () => {
				assert.equal(archived.processingStatus, "awaiting_hotelrunner");
				throw queueError;
			},
			markAudit: async (_id, fields) => {
				marker = fields;
				return { ...archived, ...fields };
			},
		}
	);
	assert.equal(result.handled, true);
	assert.equal(result.enqueueError, queueError);
	assert.equal(result.errorCode, queueError.code);
	assert.equal(archived.dedupeKey, "mid:durable-claim");
	assert.equal(archived.processingStatus, "awaiting_hotelrunner");
	assert.equal(marker["hotelRunnerFirstFallback.status"], "recovery_pending");
	assert.equal(Object.hasOwn(marker, "dedupeKey"), false);
	assert.equal(Object.hasOwn(marker, "$unset"), false);
});

test("identity collision is accepted without inline creation and becomes explicit manual review", async () => {
	let archived;
	const result = await archiveAndEnqueueHotelRunnerFirstInbound(
		{
			inboundRecord: makeInboundRecord(),
			email: {},
			normalized: makeNormalized(),
			orchestration,
			config,
		},
		{
			resolveHotelDetails: async () => activeHotel,
			persistAudit: async (_id, update) => {
				archived = { ...makeInboundRecord(), ...update };
				return archived;
			},
			enqueueArchivedEmail: async () => ({
				job: { _id: JOB_ID, status: "needs_review" },
				queued: false,
				collision: true,
			}),
			markAudit: async (_id, fields) => ({ ...archived, ...fields }),
		}
	);
	assert.equal(result.handled, true);
	assert.equal(result.collision, true);
	assert.equal(result.reconciliation.status, "needs_review");
	assert.equal(
		result.reconciliation.skipReason,
		"hotelrunner_fallback_identity_collision"
	);
});

test("queued HotelRunner-first audit statuses block a second delivery from re-entering inline creation", () => {
	assert.equal(duplicateBlockingEmailStatuses.includes("awaiting_hotelrunner"), true);
	assert.equal(
		duplicateBlockingEmailStatuses.includes("parsed_awaiting_hotelrunner"),
		true
	);
});
