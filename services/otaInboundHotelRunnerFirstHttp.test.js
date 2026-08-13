/** @format */

"use strict";

const Module = require("module");
const crypto = require("crypto");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
	isReclaimableInboundClaim: actualIsReclaimableInboundClaim,
} = require("./otaInboundDedupe");

const HOTEL_ID = "64b000000000000000000201";
const OWNER_ID = "64b000000000000000000202";
const INBOUND_ID = "64b000000000000000000203";
const DUPLICATE_ID = "64b000000000000000000204";
const JOB_ID = "64b000000000000000000205";

const sha256 = (value = "") =>
	crypto.createHash("sha256").update(String(value)).digest("hex");

const queryResult = (value) => ({
	select() {
		return this;
	},
	sort() {
		return this;
	},
	lean() {
		return this;
	},
	populate() {
		return this;
	},
	exec: async () => value,
});

const responseMock = () => ({
	statusCode: 200,
	headers: {},
	body: "",
	ended: false,
	set(name, value) {
		this.headers[name] = value;
		return this;
	},
	status(code) {
		this.statusCode = code;
		return this;
	},
	send(body) {
		this.body = body;
		this.ended = true;
		return this;
	},
});

const authenticatedSender = {
	authenticatedAligned: true,
	trustedProvider: "agoda",
	method: "dkim",
};

const normalizedReservation = () => ({
	provider: "agoda",
	providerLabel: "Agoda",
	trustedTransportProvider: "agoda",
	sourceSenderTrusted: true,
	sourceSenderAuthenticated: true,
	senderAuthentication: authenticatedSender,
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
});

function loadControllerWithStubs(state) {
	const controllerPath = require.resolve("../controllers/otaInbound");
	delete require.cache[controllerPath];
	const inboundModel = {
		findOne(query) {
			state.duplicateQueries.push(query);
			if (query?.dedupeKey) {
				return queryResult(
					state.claimedDuplicate || state.processedDuplicate || null
				);
			}
			const candidate = state.processedDuplicate || null;
			const blockingStatuses = query?.processingStatus?.$in || [];
			return queryResult(
				candidate && blockingStatuses.includes(candidate.processingStatus)
					? candidate
					: null
			);
		},
		async create(document) {
			if (document?.dedupeKey && state.createDedupeCollisions > 0) {
				state.createDedupeCollisions -= 1;
				const collision = new Error("synthetic duplicate dedupe claim");
				collision.code = 11000;
				throw collision;
			}
			state.createdAudits.push(document);
			return {
				...document,
				_id: document.duplicateOf ? DUPLICATE_ID : INBOUND_ID,
			};
		},
		findByIdAndUpdate(id, update) {
			state.auditUpdates.push({ id: String(id), update });
			if (
				update?.$set?.processingStatus === "needs_review" &&
				update?.$set?.hotelRunnerFirstFallback?.status ===
					"hotelrunner_relay_audit_only"
			) {
				state.events.push("persist_relay_audit");
			} else if (update?.$set?.processingStatus === "awaiting_hotelrunner") {
				state.events.push("persist_audit");
			} else if (
				update?.$set?.["hotelRunnerFirstFallback.status"] === "enqueued"
			) {
				state.events.push("mark_enqueued");
			}
			const latestCreated = state.createdAudits.at(-1) || {};
			const current = {
				...latestCreated,
				_id: latestCreated.duplicateOf ? DUPLICATE_ID : INBOUND_ID,
			};
			return queryResult({ ...current, ...(update.$set || {}) });
		},
		async updateOne(query, update) {
			state.claimUpdates.push({ query, update });
			const matchedCount = Number(state.claimUpdateMatched ?? 1);
			if (
				matchedCount > 0 &&
				update?.$unset?.dedupeKey !== undefined &&
				(state.claimedDuplicate || state.processedDuplicate)
			) {
				const claimed = state.claimedDuplicate || state.processedDuplicate;
				delete claimed.dedupeKey;
			}
			return { matchedCount };
		},
	};
	const stubs = new Map([
		["../models/inbound_email", inboundModel],
		["../models/user", {}],
		[
			"../services/otaReservationMapper",
			{
				hashText: sha256,
				redactSensitive: (value) => String(value || ""),
				safeSnippet: (value, max) => String(value || "").slice(0, max),
				normalizeWhitespace: (value) =>
					String(value || "").replace(/\s+/g, " ").trim(),
				evaluateTrustedSenderAuthentication: () => state.senderAuthentication,
				extractNormalizedReservation: (email) => {
					state.extractNormalizedCalls += 1;
					return {
						provider: state.senderAuthentication.trustedProvider || "unknown",
						providerLabel: "Agoda",
						intent: "new_reservation",
						eventType: "new",
						confirmationNumber: "",
						hotelName: "",
						roomName: "",
						amount: 0,
						currency: "",
						totalAmountSar: 0,
						exchangeRateToSar: 0,
						paymentCollectionModel: "unknown",
						warnings: [],
						errors: [],
						manualReviewReasons: ["bounded parser input budget"],
						otaInboundParserResourceLimitExceeded:
							email.otaInboundParserResourceLimitExceeded === true,
					};
				},
				resolveHotel: async () => {
					state.events.push("resolve_hotel");
					return {
						_id: HOTEL_ID,
						belongsTo: OWNER_ID,
						hotelName: "Zad Ajyad",
						activateHotel: true,
						xHotelProActive: true,
					};
				},
				reconcileOtaReservation: async () => {
					state.inlineReconcileCalls += 1;
					if (!state.inlineReconciliation) {
						throw new Error("eligible inbound reached inline reconciliation");
					}
					return state.inlineReconciliation;
				},
			},
		],
		[
			"../services/otaEmailOrchestrator",
			{
				orchestrateInboundReservationEmail: async () => {
					state.orchestratorCalls += 1;
					return {
						normalized:
							state.orchestrationNormalized || normalizedReservation(),
						emailContext: { forwarded: false },
						decision: { usedAI: false, skipped: true },
						safeSnippet: "Authenticated Agoda reservation",
					};
				},
				buildRedactedEmailText: (email) =>
					`${email.subject || ""}\n${email.text || ""}`,
			},
		],
		[
			"../services/inboundEmailForwarder",
			{
				forwardImportantInboundEmail: async () => {
					state.forwardCalls += 1;
					if (state.forwardMustFollowResponse) {
						assert.equal(
							state.response.ended,
							true,
							"HTTP response must be ended before optional forwarding starts"
						);
						return new Promise(() => {});
					}
					return {
						decision: { shouldForward: false, reason: "not_important" },
						forwarding: { status: "not_requested", forwardedTo: [] },
					};
				},
			},
		],
		[
			"../services/notificationEvents",
			{
				emitHotelNotificationRefresh: async () => {
					state.reservationNotificationCalls += 1;
				},
				emitPlatformNotificationRefresh: () => {
					state.reservationNotificationCalls += 1;
				},
			},
		],
		[
			"../services/otaReservationVisibility",
			{
				OTA_PLATFORM_REVIEW_PENDING: "pending",
				canManageOtaReservations: () => false,
				strictPlatformOtaHotelScopeFilter: () => null,
			},
		],
		[
			"../services/otaInboundDedupe",
			{
				INBOUND_CLAIM_LEASE_MS: 30 * 60 * 1000,
				buildInboundDedupeKey: () => "mid:synthetic",
				isReclaimableInboundClaim:
					state.isReclaimableInboundClaim || (() => false),
				shouldRetryInboundCollision: () => false,
			},
		],
		[
			"../services/otaInboundDedupeIndex",
			{
				INBOUND_DEDUPE_INDEX_UNAVAILABLE: "INBOUND_DEDUPE_INDEX_UNAVAILABLE",
				ensureInboundDedupeIndex: async () => true,
			},
		],
		[
			"../services/airbnbOtaWhatsappNotifier",
			{
				notifyAirbnbOtaInboundWhatsapp: async () => {
					state.whatsappCalls += 1;
				},
			},
		],
		[
			"../services/hotelrunnerConfig",
			{
				getHotelRunnerConfig: () =>
					state.hotelRunnerConfig || {
						integrationEnabled: true,
						configured: true,
						projectionEnabled: true,
						hotelId: HOTEL_ID,
						hrIdFingerprint: "a".repeat(64),
						otaEmailFallbackGraceMs: 180_000,
						otaEmailFallbackLeaseMs: 300_000,
						otaEmailFallbackProofTtlMs: 120_000,
						otaEmailFallbackMaxAttempts: 12,
					},
			},
		],
		[
			"../services/hotelrunnerFirstOtaFallback",
			{
				DIRECT_OTA_PROVIDERS: new Set([
					"agoda",
					"airbnb",
					"booking",
					"expedia",
					"hotels",
					"trip",
				]),
				canonicalProvider: (value) => String(value || "").trim().toLowerCase(),
				createHotelRunnerFirstOtaFallbackCoordinator: () => {
					state.coordinatorCreations += 1;
					return {
						enqueueArchivedEmail: async (input) => {
							state.events.push("enqueue");
							state.enqueueCalls.push(input);
							return {
								job: { _id: JOB_ID },
								queued: true,
								collision: false,
							};
						},
					};
				},
				safeErrorMessage: (error) => String(error?.message || error || ""),
			},
		],
	]);

	const originalLoad = Module._load;
	Module._load = function patchedLoad(request, parent, isMain) {
		if (stubs.has(request)) return stubs.get(request);
		return originalLoad.call(this, request, parent, isMain);
	};
	try {
		return require(controllerPath);
	} finally {
		Module._load = originalLoad;
		delete require.cache[controllerPath];
	}
}

const makeState = (overrides = {}) => ({
	events: [],
	createdAudits: [],
	auditUpdates: [],
	claimUpdates: [],
	duplicateQueries: [],
	enqueueCalls: [],
	inlineReconcileCalls: 0,
	inlineReconciliation: null,
	orchestratorCalls: 0,
	extractNormalizedCalls: 0,
	coordinatorCreations: 0,
	forwardCalls: 0,
	reservationNotificationCalls: 0,
	whatsappCalls: 0,
	processedDuplicate: null,
	claimedDuplicate: null,
	createDedupeCollisions: 0,
	claimUpdateMatched: 1,
	isReclaimableInboundClaim: null,
	senderAuthentication: authenticatedSender,
	orchestrationNormalized: null,
	hotelRunnerConfig: null,
	response: responseMock(),
	forwardMustFollowResponse: true,
	...overrides,
});

const requestMock = (bodyOverrides = {}) => ({
	query: { token: "inbound-secret" },
	body: {
		from: "Agoda <noreply@agoda.com>",
		to: "ota@example.com",
		subject: "New Agoda reservation 2039878308",
		text: "Authenticated reservation details",
		messageId: "<agoda-2039878308@example.com>",
		...bodyOverrides,
	},
	files: [],
	get(name) {
		if (String(name).toLowerCase() === "content-type") {
			return "application/x-www-form-urlencoded";
		}
		if (String(name).toLowerCase() === "x-inbound-secret") return "";
		return "";
	},
	app: {
		get(name) {
			return name === "io" ? { emit() {} } : null;
		},
	},
});

test("eligible HTTP ingress ACKs before optional forwarding and bypasses every inline reservation side effect", async () => {
	const originalSecret = process.env.SENDGRID_INBOUND_SECRET;
	process.env.SENDGRID_INBOUND_SECRET = "inbound-secret";
	const state = makeState();
	const controller = loadControllerWithStubs(state);
	try {
		await Promise.race([
			controller.handleSendGridInbound(requestMock(), state.response),
			new Promise((_, reject) =>
				setTimeout(
					() => reject(new Error("HTTP handler waited for optional forwarding")),
					100
				)
			),
		]);
	} finally {
		if (originalSecret === undefined) delete process.env.SENDGRID_INBOUND_SECRET;
		else process.env.SENDGRID_INBOUND_SECRET = originalSecret;
	}

	assert.equal(state.response.statusCode, 200);
	assert.equal(state.response.body, "OK");
	assert.equal(state.response.ended, true);
	assert.equal(state.forwardCalls, 1);
	assert.equal(state.inlineReconcileCalls, 0);
	assert.equal(state.reservationNotificationCalls, 0);
	assert.equal(state.whatsappCalls, 0);
	assert.equal(state.enqueueCalls.length, 1);
	assert.deepEqual(state.events, [
		"resolve_hotel",
		"persist_audit",
		"enqueue",
		"mark_enqueued",
	]);
	const archiveUpdate = state.auditUpdates[0].update.$set;
	assert.equal(archiveUpdate.processingStatus, "awaiting_hotelrunner");
	assert.equal(archiveUpdate.hotelId, HOTEL_ID);
	assert.equal(archiveUpdate.normalizedReservation.provider, "agoda");
	assert.equal(archiveUpdate.normalizedReservation.inboundEmailId, INBOUND_ID);
	assert.equal(
		state.events.indexOf("persist_audit") < state.events.indexOf("enqueue"),
		true
	);
});

test("oversized raw MIME is archived as parser-resource review without any automation path", async () => {
	const originalSecret = process.env.SENDGRID_INBOUND_SECRET;
	process.env.SENDGRID_INBOUND_SECRET = "inbound-secret";
	const state = makeState({ forwardMustFollowResponse: false });
	const controller = loadControllerWithStubs(state);
	const rawMime = [
		"From: Agoda <no-reply@agoda.com>",
		"To: ota@example.com",
		"Subject: Agoda Booking ID 777888999 - CONFIRMED",
		"Message-ID: <oversized-http-agoda@example.com>",
		"",
		"BODY MUST NOT BE PARSED",
		"A".repeat(controller.RAW_MIME_PREPARSER_MAX_BYTES + 1),
	].join("\r\n");
	try {
		await controller.handleSendGridInbound(
			requestMock({
				email: rawMime,
				text: undefined,
				SPF: "pass",
				envelope: JSON.stringify({
					from: "bounce@mailer.agoda.com",
					to: ["ota@example.com"],
				}),
			}),
			state.response
		);
	} finally {
		if (originalSecret === undefined) delete process.env.SENDGRID_INBOUND_SECRET;
		else process.env.SENDGRID_INBOUND_SECRET = originalSecret;
	}

	assert.equal(state.response.statusCode, 200);
	assert.equal(state.response.body, "OK");
	assert.equal(state.createdAudits.length, 1);
	assert.equal(state.createdAudits[0].bodyText.includes("BODY MUST NOT"), false);
	assert.equal(state.auditUpdates.length, 1);
	const finalized = state.auditUpdates[0].update.$set;
	assert.equal(finalized.processingStatus, "needs_review");
	assert.equal(finalized.skipReason, "ota_inbound_parser_resource_limit");
	assert.equal(
		finalized.normalizedReservation.otaInboundParserResourceLimitExceeded,
		true
	);
	assert.equal(finalized.orchestratorDecision.usedAI, false);
	assert.equal(
		finalized.orchestratorDecision.skipReason,
		"ota_inbound_parser_resource_limit"
	);
	assert.equal(finalized.reservationMongoId, null);
	assert.equal(finalized.hotelId, null);
	assert.equal(state.extractNormalizedCalls, 1);
	assert.equal(state.orchestratorCalls, 0);
	assert.equal(state.inlineReconcileCalls, 0);
	assert.equal(state.coordinatorCreations, 0);
	assert.equal(state.enqueueCalls.length, 0);
	assert.equal(state.forwardCalls, 0);
	assert.equal(state.reservationNotificationCalls, 0);
	assert.equal(state.whatsappCalls, 0);
	assert.deepEqual(state.events, []);
	assert.deepEqual(state.duplicateQueries, []);
});

test("master-disabled mode processes direct OTA email inline despite legacy HotelRunner settings", async () => {
	const originalSecret = process.env.SENDGRID_INBOUND_SECRET;
	process.env.SENDGRID_INBOUND_SECRET = "inbound-secret";
	const state = makeState({
		forwardMustFollowResponse: false,
		inlineReconciliation: {
			status: "created",
			actionTaken: "created",
			skipReason: "",
			warnings: [],
			errors: [],
			reservationId: "64b000000000000000000206",
			hotelId: HOTEL_ID,
			pmsConfirmationNumber: "PMS-EMAIL-ONLY-1",
		},
		hotelRunnerConfig: {
			integrationEnabled: false,
			configured: false,
			callbackConfigured: false,
			projectionEnabled: true,
			pullEnabled: true,
			roomListSyncEnabled: true,
			confirmDeliveryEnabled: true,
			token: "synthetic-present",
			hrId: "synthetic-present",
			hotelId: HOTEL_ID,
		},
	});
	const controller = loadControllerWithStubs(state);
	try {
		await controller.handleSendGridInbound(requestMock(), state.response);
	} finally {
		if (originalSecret === undefined) delete process.env.SENDGRID_INBOUND_SECRET;
		else process.env.SENDGRID_INBOUND_SECRET = originalSecret;
	}

	assert.equal(state.response.statusCode, 200);
	assert.equal(state.response.body, "OK");
	assert.equal(state.inlineReconcileCalls, 1);
	assert.equal(state.coordinatorCreations, 0);
	assert.equal(state.enqueueCalls.length, 0);
	assert.equal(state.events.includes("persist_audit"), false);
	assert.equal(state.createdAudits.length, 1);
	const finalized = state.auditUpdates.find(
		(entry) => entry.update?.$set?.processingStatus === "created"
	);
	assert.ok(finalized);
	assert.equal(
		Object.prototype.hasOwnProperty.call(
			finalized.update.$set,
			"hotelRunnerFirstFallback"
		),
		false
	);
});

test("master-disabled mode processes an authenticated HotelRunner relay through the inline email path", async () => {
	const originalSecret = process.env.SENDGRID_INBOUND_SECRET;
	process.env.SENDGRID_INBOUND_SECRET = "inbound-secret";
	const relayAuthentication = {
		authenticatedAligned: true,
		trustedProvider: "hotelrunner",
		method: "dkim",
	};
	const state = makeState({
		forwardMustFollowResponse: false,
		senderAuthentication: relayAuthentication,
		orchestrationNormalized: {
			...normalizedReservation(),
			trustedTransportProvider: "hotelrunner",
			senderAuthentication: relayAuthentication,
			hotelRunnerCommercialSourceProviders: ["agoda"],
		},
		inlineReconciliation: {
			status: "created",
			actionTaken: "created",
			skipReason: "",
			warnings: [],
			errors: [],
			reservationId: "64b000000000000000000207",
			hotelId: HOTEL_ID,
			pmsConfirmationNumber: "PMS-EMAIL-ONLY-RELAY-1",
		},
		hotelRunnerConfig: {
			integrationEnabled: false,
			configured: false,
			callbackConfigured: false,
			projectionEnabled: true,
			pullEnabled: true,
			roomListSyncEnabled: true,
			confirmDeliveryEnabled: true,
			token: "synthetic-present",
			hrId: "synthetic-present",
			hotelId: HOTEL_ID,
		},
	});
	const controller = loadControllerWithStubs(state);
	try {
		await controller.handleSendGridInbound(
			requestMock({
				from: "HotelRunner <noreply@hotelrunner.com>",
				subject: "Agoda reservation relayed by HotelRunner",
				messageId: "<disabled-hotelrunner-relay@example.com>",
			}),
			state.response
		);
	} finally {
		if (originalSecret === undefined) delete process.env.SENDGRID_INBOUND_SECRET;
		else process.env.SENDGRID_INBOUND_SECRET = originalSecret;
	}

	assert.equal(state.response.statusCode, 200);
	assert.equal(state.response.body, "OK");
	assert.equal(state.inlineReconcileCalls, 1);
	assert.equal(state.coordinatorCreations, 0);
	assert.equal(state.enqueueCalls.length, 0);
	assert.equal(state.events.includes("persist_relay_audit"), false);
	assert.ok(
		state.auditUpdates.some(
			(entry) => entry.update?.$set?.processingStatus === "created"
		)
	);
});

test("projection-off configured property is archived and returns retry without inline mutation", async () => {
	const originalSecret = process.env.SENDGRID_INBOUND_SECRET;
	process.env.SENDGRID_INBOUND_SECRET = "inbound-secret";
	const state = makeState({
			hotelRunnerConfig: {
				integrationEnabled: true,
				configured: false,
			projectionEnabled: false,
			hotelId: HOTEL_ID,
			hrIdFingerprint: "a".repeat(64),
		},
	});
	const controller = loadControllerWithStubs(state);
	try {
		await controller.handleSendGridInbound(requestMock(), state.response);
	} finally {
		if (originalSecret === undefined) delete process.env.SENDGRID_INBOUND_SECRET;
		else process.env.SENDGRID_INBOUND_SECRET = originalSecret;
	}

	assert.equal(state.response.statusCode, 503);
	assert.equal(state.response.headers["Retry-After"], "60");
	assert.equal(state.inlineReconcileCalls, 0);
	assert.equal(state.coordinatorCreations, 0);
	assert.equal(state.enqueueCalls.length, 0);
	assert.equal(state.reservationNotificationCalls, 0);
	assert.equal(state.whatsappCalls, 0);
	assert.deepEqual(state.events, ["resolve_hotel", "persist_audit"]);
	const archive = state.auditUpdates[0].update.$set;
	assert.equal(archive.processingStatus, "awaiting_hotelrunner");
	assert.equal(archive.hotelRunnerFirstFallback.status, "recovery_pending");
	assert.equal(
		archive.hotelRunnerFirstFallback.lastErrorCode,
		"HOTELRUNNER_FIRST_PROJECTION_UNAVAILABLE"
	);
});

test("authenticated HotelRunner relay HTTP ingress is audit-only and never reaches queue or reservation side effects", async () => {
	const originalSecret = process.env.SENDGRID_INBOUND_SECRET;
	process.env.SENDGRID_INBOUND_SECRET = "inbound-secret";
	const relayAuthentication = {
		authenticatedAligned: true,
		trustedProvider: "hotelrunner",
		method: "dkim",
	};
	const state = makeState({
		senderAuthentication: relayAuthentication,
		orchestrationNormalized: {
			...normalizedReservation(),
			trustedTransportProvider: "hotelrunner",
			senderAuthentication: relayAuthentication,
			hotelRunnerCommercialSourceProviders: ["agoda"],
		},
	});
	const controller = loadControllerWithStubs(state);
	try {
		await Promise.race([
			controller.handleSendGridInbound(
				requestMock({
					from: "HotelRunner <noreply@hotelrunner.com>",
					subject: "Agoda reservation relayed by HotelRunner",
					messageId: "<hotelrunner-agoda-2039878308@example.com>",
				}),
				state.response
			),
			new Promise((_, reject) =>
				setTimeout(
					() => reject(new Error("relay audit waited for optional forwarding")),
					100
				)
			),
		]);
	} finally {
		if (originalSecret === undefined) delete process.env.SENDGRID_INBOUND_SECRET;
		else process.env.SENDGRID_INBOUND_SECRET = originalSecret;
	}

	assert.equal(state.response.statusCode, 200);
	assert.equal(state.response.body, "OK");
	assert.equal(state.response.ended, true);
	assert.equal(state.orchestratorCalls, 1);
	assert.equal(state.coordinatorCreations, 0);
	assert.equal(state.enqueueCalls.length, 0);
	assert.equal(state.inlineReconcileCalls, 0);
	assert.equal(state.reservationNotificationCalls, 0);
	assert.equal(state.whatsappCalls, 0);
	assert.equal(state.forwardCalls, 1);
	assert.deepEqual(state.events, ["resolve_hotel", "persist_relay_audit"]);
	assert.equal(state.auditUpdates.length, 1);
	const audit = state.auditUpdates[0].update.$set;
	assert.equal(audit.processingStatus, "needs_review");
	assert.equal(audit.provider, "agoda");
	assert.equal(audit.reconciliation.skipReason, "hotelrunner_relay_audit_only");
	assert.equal(
		audit.hotelRunnerFirstFallback.status,
		"hotelrunner_relay_audit_only"
	);
	assert.equal(audit.hotelRunnerFirstFallback.jobId, null);
});

test("duplicate redelivery of an awaiting audit returns OK without orchestration or a second queue job", async () => {
	const originalSecret = process.env.SENDGRID_INBOUND_SECRET;
	process.env.SENDGRID_INBOUND_SECRET = "inbound-secret";
	const originalAwaitingAudit = {
		_id: INBOUND_ID,
		processingStatus: "awaiting_hotelrunner",
		receivedAt: new Date("2026-08-09T15:00:00.000Z"),
		dedupeKey: "mid:original",
		reservationMongoId: null,
		hotelId: HOTEL_ID,
		provider: "agoda",
		providerLabel: "Agoda",
		intent: "new_reservation",
		eventType: "new",
		confirmationNumber: "2039878308",
		hotelName: "Zad Ajyad",
		roomName: "Double Room",
		sourceAmount: 588,
		sourceCurrency: "SAR",
		totalAmountSar: 588,
		paymentCollectionModel: "ota_collect",
	};
	const state = makeState({ processedDuplicate: originalAwaitingAudit });
	const controller = loadControllerWithStubs(state);
	try {
		await controller.handleSendGridInbound(requestMock(), state.response);
	} finally {
		if (originalSecret === undefined) delete process.env.SENDGRID_INBOUND_SECRET;
		else process.env.SENDGRID_INBOUND_SECRET = originalSecret;
	}

	assert.equal(state.response.statusCode, 200);
	assert.equal(state.response.body, "OK");
	assert.equal(state.orchestratorCalls, 0);
	assert.equal(state.coordinatorCreations, 0);
	assert.equal(state.enqueueCalls.length, 0);
	assert.equal(state.inlineReconcileCalls, 0);
	assert.equal(originalAwaitingAudit.processingStatus, "awaiting_hotelrunner");
	assert.equal(state.createdAudits[0].duplicateOf, INBOUND_ID);
	assert.equal(
		state.duplicateQueries[0].processingStatus.$in.includes(
			"awaiting_hotelrunner"
		),
		true
	);
});

test("an unlinked needs-review dedupe claim is conditionally reclaimed and the delivery is reprocessed", async () => {
	const originalSecret = process.env.SENDGRID_INBOUND_SECRET;
	process.env.SENDGRID_INBOUND_SECRET = "inbound-secret";
	const originalReview = {
		_id: INBOUND_ID,
		processingStatus: "needs_review",
		receivedAt: new Date("2026-08-13T20:00:00.000Z"),
		dedupeKey: "mid:synthetic",
		reservationMongoId: null,
		hasReservationConnection: false,
		reconciliation: { reservationId: null },
		provider: "agoda",
		providerLabel: "Agoda",
		intent: "new_reservation",
		eventType: "new",
		confirmationNumber: "2039878308",
	};
	const state = makeState({
		processedDuplicate: originalReview,
		createDedupeCollisions: 1,
		isReclaimableInboundClaim: actualIsReclaimableInboundClaim,
		forwardMustFollowResponse: false,
		inlineReconciliation: {
			status: "created",
			actionTaken: "created",
			warnings: [],
			errors: [],
			reservationId: "64b000000000000000000206",
			hotelId: HOTEL_ID,
			pmsConfirmationNumber: "PMS-RECLAIMED-1",
		},
		hotelRunnerConfig: {
			integrationEnabled: false,
			configured: false,
			callbackConfigured: false,
			projectionEnabled: false,
			pullEnabled: false,
			roomListSyncEnabled: false,
			confirmDeliveryEnabled: false,
			hotelId: HOTEL_ID,
		},
	});
	const controller = loadControllerWithStubs(state);
	try {
		await controller.handleSendGridInbound(requestMock(), state.response);
	} finally {
		if (originalSecret === undefined) delete process.env.SENDGRID_INBOUND_SECRET;
		else process.env.SENDGRID_INBOUND_SECRET = originalSecret;
	}

	assert.equal(state.response.statusCode, 200);
	assert.equal(state.orchestratorCalls, 1);
	assert.equal(state.inlineReconcileCalls, 1);
	assert.equal(state.claimUpdates.length, 1);
	assert.deepEqual(state.claimUpdates[0].update, { $unset: { dedupeKey: "" } });
	const reviewCas = state.claimUpdates[0].query.$or.find(
		(branch) => branch.processingStatus?.$in
	);
	assert.deepEqual(reviewCas.processingStatus.$in, [
		"needs_review",
		"needs_mapping",
	]);
	assert.equal(reviewCas.reservationMongoId, null);
	assert.deepEqual(reviewCas.hasReservationConnection, { $ne: true });
	assert.equal(reviewCas["reconciliation.reservationId"], null);
	assert.equal(state.createdAudits.length, 1);
	assert.equal(state.createdAudits[0].duplicateOf, null);
	assert.equal(state.createdAudits[0].dedupeKey, "mid:synthetic");
});

test("reservation linkage markers prevent needs-review claim reclaim and preserve duplicate handling", async () => {
	const originalSecret = process.env.SENDGRID_INBOUND_SECRET;
	process.env.SENDGRID_INBOUND_SECRET = "inbound-secret";
	const markerCases = [
		{ label: "reservation id", reservationMongoId: "64b000000000000000000206" },
		{ label: "connection marker", hasReservationConnection: true },
		{ label: "reconciliation link", reconciliation: { reservationId: "64b000000000000000000206" } },
	];
	try {
		for (const marker of markerCases) {
			const originalReview = {
				_id: INBOUND_ID,
				processingStatus: "needs_review",
				receivedAt: new Date("2026-08-13T20:00:00.000Z"),
				dedupeKey: "mid:synthetic",
				reservationMongoId: null,
				hasReservationConnection: false,
				reconciliation: { reservationId: null },
				provider: "agoda",
				providerLabel: "Agoda",
				intent: "new_reservation",
				eventType: "new",
				confirmationNumber: "2039878308",
				...marker,
			};
			delete originalReview.label;
			const state = makeState({
				processedDuplicate: originalReview,
				createDedupeCollisions: 1,
				isReclaimableInboundClaim: actualIsReclaimableInboundClaim,
				forwardMustFollowResponse: false,
			});
			const controller = loadControllerWithStubs(state);
			await controller.handleSendGridInbound(requestMock(), state.response);

			assert.equal(state.response.statusCode, 200, marker.label);
			assert.equal(state.claimUpdates.length, 0, marker.label);
			assert.equal(state.orchestratorCalls, 0, marker.label);
			assert.equal(state.inlineReconcileCalls, 0, marker.label);
			assert.equal(state.createdAudits.length, 1, marker.label);
			assert.equal(state.createdAudits[0].duplicateOf, INBOUND_ID, marker.label);
		}
	} finally {
		if (originalSecret === undefined) delete process.env.SENDGRID_INBOUND_SECRET;
		else process.env.SENDGRID_INBOUND_SECRET = originalSecret;
	}
});

test("a lost needs-review reclaim CAS remains duplicate and never reprocesses concurrently linked work", async () => {
	const originalSecret = process.env.SENDGRID_INBOUND_SECRET;
	process.env.SENDGRID_INBOUND_SECRET = "inbound-secret";
	const originalReview = {
		_id: INBOUND_ID,
		processingStatus: "needs_review",
		receivedAt: new Date("2026-08-13T20:00:00.000Z"),
		dedupeKey: "mid:synthetic",
		reservationMongoId: null,
		hasReservationConnection: false,
		reconciliation: { reservationId: null },
		provider: "agoda",
		intent: "new_reservation",
		confirmationNumber: "2039878308",
	};
	const state = makeState({
		processedDuplicate: originalReview,
		createDedupeCollisions: 1,
		claimUpdateMatched: 0,
		isReclaimableInboundClaim: actualIsReclaimableInboundClaim,
		forwardMustFollowResponse: false,
	});
	const controller = loadControllerWithStubs(state);
	try {
		await controller.handleSendGridInbound(requestMock(), state.response);
	} finally {
		if (originalSecret === undefined) delete process.env.SENDGRID_INBOUND_SECRET;
		else process.env.SENDGRID_INBOUND_SECRET = originalSecret;
	}

	assert.equal(state.response.statusCode, 200);
	assert.equal(state.claimUpdates.length, 1);
	assert.equal(state.orchestratorCalls, 0);
	assert.equal(state.inlineReconcileCalls, 0);
	assert.equal(state.createdAudits.length, 1);
	assert.equal(state.createdAudits[0].duplicateOf, INBOUND_ID);
	assert.equal(originalReview.dedupeKey, "mid:synthetic");
});
