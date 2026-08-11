/** @format */

process.env.SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "SG.test";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const {
	HOTELRUNNER_EMAIL_COMMERCIAL_BRIDGE_PROJECTION,
	HOTELRUNNER_QUEUED_EMAIL_COMMERCIAL_AUDIT_PROJECTION,
	HOTELRUNNER_QUEUED_EMAIL_COMMERCIAL_JOB_PROJECTION,
	loadHotelRunnerEmailCommercialBridge,
	loadHotelRunnerQueuedEmailCommercialBridge,
	validateHotelRunnerQueuedEmailCommercialBridgeRooms,
} = require("./hotelrunnerEmailCommercialBridge");
const {
	createArchiveFingerprint,
} = require("./hotelrunnerFirstOtaFallback");
const {
	applyLiveSarConversion,
	buildHotelRunnerEmailCommercialEvidence,
} = require("./otaReservationMapper");

const RESERVATION_ID = "64b000000000000000000301";
const INBOUND_ID = "64b000000000000000000302";

function authenticatedInbound(overrides = {}) {
	return {
		inboundEmailId: INBOUND_ID,
		provider: "agoda",
		trustedTransportProvider: "agoda",
		confirmationNumber: "687268443",
		reservationId: "687268443",
		sourceSenderTrusted: true,
		sourceSenderAuthenticated: true,
		requiresManualReview: false,
		checkinDate: "2026-08-20",
		checkoutDate: "2026-08-21",
		roomCount: 1,
		amount: 95.06,
		totalAmountSar: 95.06,
		sourceAmount: 95.06,
		sourceCurrency: "SAR",
		currency: "SAR",
		totalPayoutSar: 58.82,
		netAfterExpensesTotal: 58.82,
		sourceExchangeRateToSar: 1,
		exchangeRateToSar: 1,
		paymentCollectionModel: "ota_collect",
		paymentInstructions: "OTA collected payment",
		paymentSummary: {
			sourceCurrency: "SAR",
			sourceTotalGuestPaymentAmount: 95.06,
			sourceTotalPayoutAmount: 58.82,
			totalGuestPaymentAmount: 95.06,
			totalPayoutAmount: 58.82,
			currency: "SAR",
			exchangeRateToSar: 1,
		},
		sourcePresence: {
			confirmationNumber: true,
			hotelName: true,
			roomName: true,
			checkinDate: true,
			checkoutDate: true,
			roomCount: true,
			amount: true,
			paymentCollectionModel: true,
			paymentInstructions: true,
		},
		source: {
			receivedAt: "2026-08-07T15:26:53.000Z",
			textHash:
				"b75f4f44ee6f4211cfa54f69d4d347a38f38477789f86c0b9c19b67dd398e23a",
		},
		...overrides,
	};
}

function materializedExisting(inbound = authenticatedInbound(), overrides = {}) {
	const marker = buildHotelRunnerEmailCommercialEvidence(
		{
			...inbound,
			inboundEmailId: inbound.inboundEmailId || INBOUND_ID,
		},
		{
			appliedAt: new Date("2026-08-07T15:27:00.000Z"),
		}
	);
	assert.ok(marker, "fixture must contain explicit commercial evidence");
	const paymentSummary = { ...inbound.paymentSummary };
	const rootTotal = 50;
	const platformMargin = Number(
		(Number(marker.payoutTotalSar) - rootTotal).toFixed(2)
	);
	return {
		_id: RESERVATION_ID,
		otaIdentityKey: `agoda:${inbound.confirmationNumber}`,
		otaCrossTransportIdentityKey: "",
		checkin_date: inbound.checkinDate,
		checkout_date: inbound.checkoutDate,
		total_rooms: inbound.roomCount,
		total_amount: marker.grossTotalSar,
		commission_ota: null,
		pickedRoomsPricing: [
			{
				count: 1,
				pricingByDay: [
					{
						clientPrice: marker.grossTotalSar,
						rootPrice: rootTotal,
						netAfterExpenses: marker.payoutTotalSar,
						otaExpenseAmount: marker.otaExpenseTotalSar,
						platformMargin,
						hotelRunnerSourcePrice: marker.payoutTotalSar,
					},
				],
			},
		],
		adminPricing: {
			clientTotal: marker.grossTotalSar,
			rootTotal,
			netAfterExpensesTotal: marker.payoutTotalSar,
			otaExpenseTotal: marker.otaExpenseTotalSar,
			platformMarginTotal: platformMargin,
			defaultDeductionApplied: false,
			commercialVerified: false,
			payoutFallbackReason: "hotelrunner_commercial_evidence_stale",
		},
		ota_financial_summary: {
			show: false,
			clientTotal: marker.grossTotalSar,
			netAfterExpenses: marker.payoutTotalSar,
			netAfterOtaExpenses: marker.payoutTotalSar,
			otaExpenseTotal: marker.otaExpenseTotalSar,
			commercialVerified: false,
			payoutFallbackReason: "hotelrunner_commercial_evidence_stale",
			paymentSummary,
		},
		supplierData: {
			otaLastInboundEmailId: INBOUND_ID,
			otaTotalPayoutSar: marker.payoutTotalSar,
			otaExpenseTotalSar: marker.otaExpenseTotalSar,
			otaCommissionSar: null,
			otaCommissionSource: "",
			otaCommissionSourceBacked: false,
			otaPayoutFallbackReason: "hotelrunner_commercial_evidence_stale",
			otaPaymentSummary: paymentSummary,
		},
		...overrides,
	};
}

function inboundRecord(normalized = authenticatedInbound(), overrides = {}) {
	return {
		_id: INBOUND_ID,
		provider: normalized.provider,
		confirmationNumber: normalized.confirmationNumber,
		reservationMongoId: RESERVATION_ID,
		hasReservationConnection: true,
		processingStatus: "created",
		automationAction: "created_unmapped_ota_review",
		normalizedReservation: normalized,
		...overrides,
	};
}

function hotelRunnerNormalized(overrides = {}) {
	return {
		providerNumber: "687268443",
		checkinDate: "2026-08-20",
		checkoutDate: "2026-08-21",
		totalRooms: 1,
		rooms: [{}],
		currency: "SAR",
		totalCents: 5882,
		...overrides,
	};
}

function modelFor(record, observations = {}) {
	return {
		findById(value) {
			observations.lookupId = String(value);
			return {
				select(projection) {
					observations.projection = projection;
					return this;
				},
				lean() {
					observations.lean = true;
					return this;
				},
				async exec() {
					return record;
				},
			};
		},
	};
}

function jobsModelFor(records, observations = {}) {
	return {
		find(filter) {
			observations.filter = filter;
			return {
				select(projection) {
					observations.projection = projection;
					return this;
				},
				sort(sort) {
					observations.sort = sort;
					return this;
				},
				limit(limit) {
					observations.limit = limit;
					return this;
				},
				lean() {
					observations.lean = true;
					return this;
				},
				async exec() {
					return records;
				},
			};
		},
	};
}

async function queuedTripFixture() {
	const hotelId = "64b000000000000000000401";
	const ownerId = "64b000000000000000000402";
	const roomId = "64b000000000000000000403";
	const jobId = "64b000000000000000000404";
	const inboundId = "64b000000000000000000405";
	const confirmationNumber = "1653715890127438";
	const fingerprint = "f".repeat(64);
	const sourceTimestamp = "2026-08-09T00:00:00.000Z";
	const fetchedAt = "2026-08-09T06:00:00.000Z";
	const base = authenticatedInbound({
		inboundEmailId: inboundId,
		provider: "trip",
		trustedTransportProvider: "trip",
		confirmationNumber,
		reservationId: confirmationNumber,
		intent: "new_reservation",
		eventType: "new",
		hotelName: "Zad Ajyad",
		roomName: "Double Room",
		checkinDate: "2026-08-09",
		checkoutDate: "2026-08-10",
		roomCount: 1,
		amount: null,
		totalAmountSar: null,
		sourceAmount: 21.4,
		sourceCurrency: "USD",
		currency: "USD",
		propertyCurrency: "SAR",
		propertyConversionVerified: false,
		totalPayoutSar: null,
		netAfterExpensesTotal: null,
		exchangeRateToSar: null,
		sourceExchangeRateToSar: null,
		paymentSummary: {
			sourceCurrency: "USD",
			sourceTotalGuestPaymentAmount: 21.4,
			sourceTotalPayoutAmount: 18.2,
			sourceTotalPayoutCurrency: "USD",
			totalGuestPaymentAmount: null,
			totalPayoutAmount: null,
			currency: null,
			exchangeRateToSar: null,
		},
		sourcePresence: {
			confirmationNumber: true,
			hotelName: true,
			roomName: true,
			checkinDate: true,
			checkoutDate: true,
			roomCount: true,
			amount: true,
			paymentCollectionModel: true,
			paymentInstructions: true,
		},
		source: {
			receivedAt: "2026-08-09T05:59:00.000Z",
			textHash: "6".repeat(64),
		},
	});
	const live = await applyLiveSarConversion(base, {
		apiKey: "queued-trip-bridge-test",
		cache: new Map(),
		now: () => Date.parse(fetchedAt),
		fetchImpl: async () => ({
			ok: true,
			async json() {
				return {
					result: "success",
					base_code: "USD",
					target_code: "SAR",
					conversion_rate: 3.8,
					time_last_update_unix: Date.parse(sourceTimestamp) / 1000,
				};
			},
		}),
	});
	const inbound = await applyLiveSarConversion(live, {
		rateLookup: async () => {
			throw new Error("trusted stored FX evidence must avoid a new lookup");
		},
	});
	const audit = {
		_id: inboundId,
		hotelId,
		provider: "trip",
		confirmationNumber,
		intent: "new_reservation",
		eventType: "new",
		emailHash: "a".repeat(64),
		senderAuthentication: {
			authenticatedAligned: true,
			trustedProvider: "trip",
		},
		reservationMongoId: null,
		hasReservationConnection: false,
		processingStatus: "awaiting_hotelrunner",
		automationAction: "queued",
		hotelRunnerFirstFallback: {
			status: "archive_ready",
			jobId: null,
			resolvedHotelProof: {
				version: 1,
				hotelId,
				belongsTo: ownerId,
				currency: "SAR",
				activateHotel: true,
				xHotelProActive: true,
			},
		},
		normalizedReservation: inbound,
	};
	const identity = { hotelId, provider: "trip", confirmationNumber };
	const fingerprints = createArchiveFingerprint({ identity, audit });
	const job = {
		_id: jobId,
		...identity,
		lookupConfirmationNumber: confirmationNumber,
		identityKey: `trip:${confirmationNumber}`,
		hrIdFingerprint: fingerprint,
		...fingerprints,
		status: "awaiting_hotelrunner",
		identityConflict: false,
		leaseOwner: "",
		leaseToken: "",
		leaseAcquiredAt: null,
		leaseUntil: null,
	};
	const hotel = {
		_id: hotelId,
		belongsTo: ownerId,
		hotelName: "Zad Ajyad",
		activateHotel: true,
		xHotelProActive: true,
		currency: "SAR",
		roomCountDetails: [
			{
				_id: roomId,
				roomType: "doubleRooms",
				displayName: "Double Room",
				activeRoom: true,
			},
		],
	};
	const normalized = {
		providerNumber: confirmationNumber,
		channel: "tripcom",
		channelDisplay: "Trip.com",
		sourceDisplay: "Trip.com",
		checkinDate: "2026-08-09",
		checkoutDate: "2026-08-10",
		totalRooms: 1,
		rooms: [{}],
		currency: "USD",
		totalCents: 1820,
	};
	return {
		audit,
		config: { hotelId, hrIdFingerprint: fingerprint },
		fingerprints,
		hotel,
		inbound,
		job,
		normalized,
		ownerId,
		roomId,
	};
}

test("Agoda HotelRunner payout is accepted only with the exact verified email evidence", async () => {
	const inbound = authenticatedInbound();
	delete inbound.inboundEmailId;
	const existing = materializedExisting(inbound);
	assert.equal(existing.supplierData.hotelRunnerEmailCommercialEvidence, undefined);
	assert.equal(existing.adminPricing.commercialVerified, false);
	const observations = {};
	const result = await loadHotelRunnerEmailCommercialBridge(
		{ existing, normalized: hotelRunnerNormalized(), provider: "agoda" },
		{ InboundEmailModel: modelFor(inboundRecord(inbound), observations) }
	);
	assert.equal(result.ok, true);
	assert.equal(result.amountRole, "payout");
	assert.equal(result.sourceCurrency, "SAR");
	assert.equal(result.sourceAmount, 95.06);
	assert.equal(result.grossTotalSar, 95.06);
	assert.equal(result.evidence.otaExpenseTotalSar, 36.24);
	assert.equal(observations.lookupId, INBOUND_ID);
	assert.equal(observations.lean, true);
	assert.equal(observations.projection, HOTELRUNNER_EMAIL_COMMERCIAL_BRIDGE_PROJECTION);
	for (const forbidden of ["bodyText", "bodyHtml", "from", "subject", "guestName", "payment_details"]) {
		assert.equal(observations.projection.includes(forbidden), false);
	}
});

test("Trip HotelRunner relay keeps the matching USD amount commercially unresolved", async () => {
	const inbound = authenticatedInbound({
		provider: "hotelrunner",
		confirmationNumber: "1539366616295913",
		reservationId: "1539366616295913",
		amount: 18.78,
		totalAmountSar: 70.43,
		sourceAmount: 18.78,
		sourceCurrency: "USD",
		currency: "USD",
		totalPayoutSar: 56.34,
		netAfterExpensesTotal: 56.34,
		sourceExchangeRateToSar: 3.75,
		sourceExchangeRateSource: "fallback_default",
		exchangeRateToSar: 3.75,
		exchangeRateSource: "fallback_default",
		otaPayoutFallbackReason: "estimated_default_deduction",
		paymentSummary: {
			sourceCurrency: "USD",
			sourceTotalGuestPaymentAmount: 18.78,
			sourceTotalPayoutAmount: 15.02,
			totalGuestPaymentAmount: 70.43,
			totalPayoutAmount: 56.34,
			currency: "SAR",
			exchangeRateToSar: 3.75,
			exchangeRateSource: "fallback_default",
		},
	});
	const existing = {
		_id: RESERVATION_ID,
		otaIdentityKey: "hotelrunner:1539366616295913",
		otaCrossTransportIdentityKey: "trip:1539366616295913",
		checkin_date: inbound.checkinDate,
		checkout_date: inbound.checkoutDate,
		total_rooms: 1,
		supplierData: { otaLastInboundEmailId: INBOUND_ID },
	};
	const result = await loadHotelRunnerEmailCommercialBridge(
		{
			existing,
			normalized: hotelRunnerNormalized({
				providerNumber: "1539366616295913",
				currency: "USD",
				totalCents: 1878,
			}),
			provider: "trip",
		},
		{ InboundEmailModel: modelFor(inboundRecord(inbound)) }
	);
	assert.equal(result.ok, true);
	assert.equal(result.amountRole, "unknown");
	assert.equal(result.sourceCurrency, "USD");
	assert.equal(result.sourceAmount, 18.78);
	assert.equal(result.grossTotalSar, null);
	assert.equal(result.evidence, null);

	const payoutAttempt = await loadHotelRunnerEmailCommercialBridge(
		{
			existing,
			normalized: hotelRunnerNormalized({
				providerNumber: "1539366616295913",
				currency: "USD",
				totalCents: 1502,
			}),
			provider: "trip",
		},
		{ InboundEmailModel: modelFor(inboundRecord(inbound)) }
	);
	assert.deepEqual(payoutAttempt, {
		ok: false,
		reason: "payout_evidence_required",
		amountRole: "",
	});
});

test("Trip bridge accepts different cross-currency amounts only with trusted conversion evidence", async () => {
	const confirmationNumber = "7711223344556699";
	const fetchedAt = "2026-08-09T08:00:00.000Z";
	const sourceTimestamp = "2026-08-09T00:00:00.000Z";
	const inbound = await applyLiveSarConversion(
		authenticatedInbound({
			provider: "trip",
			trustedTransportProvider: "trip",
			confirmationNumber,
			reservationId: confirmationNumber,
			amount: 23.4,
			totalAmountSar: null,
			sourceAmount: 23.4,
			sourceCurrency: "USD",
			currency: "USD",
			propertyCurrency: "SAR",
			propertyConversionVerified: false,
			totalPayoutSar: null,
			netAfterExpensesTotal: null,
			paymentSummary: {
				sourceCurrency: "USD",
				sourceTotalGuestPaymentAmount: 23.4,
				sourceTotalPayoutAmount: 20.1,
				totalGuestPaymentAmount: null,
				totalPayoutAmount: null,
				currency: null,
			},
			source: {
				receivedAt: "2026-08-09T07:45:00.000Z",
				textHash:
					"6e6dc9e61568504ea2e5b38fbf0c632cb3e5e6a3c5902306b5064102d42fa711",
			},
		}),
		{
			apiKey: "bridge-test-credential",
			cache: new Map(),
			now: () => Date.parse(fetchedAt),
			fetchImpl: async () => ({
				ok: true,
				async json() {
					return {
						result: "success",
						base_code: "USD",
						target_code: "SAR",
						conversion_rate: 3.81,
						time_last_update_unix:
							Date.parse(sourceTimestamp) / 1000,
					};
				},
			}),
		}
	);
	const existing = materializedExisting(inbound, {
		otaIdentityKey: `hotelrunner:${confirmationNumber}`,
		otaCrossTransportIdentityKey: `trip:${confirmationNumber}`,
	});
	const observations = {};
	const result = await loadHotelRunnerEmailCommercialBridge(
		{
			existing,
			normalized: hotelRunnerNormalized({
				providerNumber: confirmationNumber,
				currency: "USD",
				totalCents: 2010,
			}),
			provider: "trip",
		},
		{ InboundEmailModel: modelFor(inboundRecord(inbound), observations) }
	);

	assert.equal(inbound.currency, "SAR");
	assert.equal(inbound.sourceCurrency, "USD");
	assert.equal(inbound.totalAmountSar, 89.15);
	assert.equal(inbound.totalPayoutSar, 76.58);
	assert.equal(inbound.propertyConversionVerified, true);
	assert.equal(
		inbound.currencyConversionEvidence.provenance.provider,
		"exchange_rate_api"
	);
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.amountRole, "payout");
	assert.equal(result.grossTotalSar, 89.15);
	assert.equal(result.evidence.payoutTotalSar, 76.58);
	assert.equal(result.evidence.otaExpenseTotalSar, 12.57);
	assert.ok(
		observations.projection.includes(
			"normalizedReservation.currencyConversionEvidence"
		)
	);
});

test("Agoda payout fails closed when stored commercial aliases are not exact", async () => {
	const inbound = authenticatedInbound();
	const existing = materializedExisting(inbound);
	existing.adminPricing.otaExpenseTotal = 1;
	const result = await loadHotelRunnerEmailCommercialBridge(
		{ existing, normalized: hotelRunnerNormalized(), provider: "agoda" },
		{ InboundEmailModel: modelFor(inboundRecord(inbound)) }
	);
	assert.deepEqual(result, {
		ok: false,
		reason: "payout_evidence_required",
		amountRole: "",
	});
});

test("bridge fails closed on identity, stay, room, currency, amount, auth, and reservation mismatches", async (t) => {
	const make = () => {
		const inbound = authenticatedInbound();
		return {
			inbound,
			existing: materializedExisting(inbound),
			normalized: hotelRunnerNormalized(),
			record: inboundRecord(inbound),
		};
	};
	const cases = [
		["identity", "provider_identity_mismatch", (x) => { x.normalized.providerNumber = "wrong"; }],
		["audit identity", "provider_identity_mismatch", (x) => { x.record.confirmationNumber = "wrong"; }],
		["stay", "stay_mismatch", (x) => { x.normalized.checkoutDate = "2026-08-22"; }],
		["room count", "room_count_mismatch", (x) => { x.normalized.totalRooms = 2; x.normalized.rooms = [{}, {}]; }],
		["currency", "currency_mismatch", (x) => { x.normalized.currency = "USD"; }],
		["amount", "amount_mismatch", (x) => { x.normalized.totalCents = 6000; }],
		["authentication", "source_not_authenticated", (x) => { x.record.normalizedReservation.sourceSenderAuthenticated = false; }],
		["reservation link", "reservation_link_mismatch", (x) => { x.record.reservationMongoId = "64b000000000000000000399"; }],
	];
	for (const [name, reason, mutate] of cases) {
		await t.test(name, async () => {
			const fixture = make();
			mutate(fixture);
			const result = await loadHotelRunnerEmailCommercialBridge(
				{ existing: fixture.existing, normalized: fixture.normalized, provider: "agoda" },
				{ InboundEmailModel: modelFor(fixture.record) }
			);
			assert.equal(result.ok, false);
			assert.equal(result.reason, reason);
		});
	}
});

test("bridge is read-only and does not mutate reservation, event, or inbound audit", async () => {
	const inbound = authenticatedInbound();
	const record = inboundRecord(inbound);
	const existing = materializedExisting(inbound);
	const normalized = hotelRunnerNormalized();
	const before = JSON.stringify({ inbound, record, existing, normalized });
	const model = modelFor(record);
	model.updateOne = () => assert.fail("bridge must never update an inbound email");
	model.findOneAndUpdate = () => assert.fail("bridge must never mutate data");
	const result = await loadHotelRunnerEmailCommercialBridge(
		{ existing, normalized, provider: "agoda" },
		{ InboundEmailModel: model }
	);
	assert.equal(result.ok, true);
	assert.equal(JSON.stringify({ inbound, record, existing, normalized }), before);
});

test("immutable creation audit outranks a later lifecycle-email reference", async () => {
	const inbound = authenticatedInbound();
	const existing = materializedExisting(inbound);
	existing.supplierData.otaInboundEmailId = INBOUND_ID;
	existing.supplierData.otaLastInboundEmailId =
		"64b000000000000000000399";
	const observations = {};
	const result = await loadHotelRunnerEmailCommercialBridge(
		{ existing, normalized: hotelRunnerNormalized(), provider: "agoda" },
		{ InboundEmailModel: modelFor(inboundRecord(inbound), observations) }
	);
	assert.equal(result.ok, true);
	assert.equal(result.amountRole, "payout");
	assert.equal(observations.lookupId, INBOUND_ID);
});

test("a coordinator-finalized API creation audit remains exact commercial provenance for later HotelRunner updates", async () => {
	const inbound = authenticatedInbound({
		intent: "new_reservation",
		eventType: "new",
	});
	const existing = materializedExisting(inbound);
	existing.supplierData.otaInboundEmailId = INBOUND_ID;
	existing.supplierData.otaAutomationPipeline = "hotelrunner-background-worker";
	existing.supplierData.otaSourceAuthority = 4;
	existing.supplierData.hotelRunner = { transport: "hotelrunner_api" };
	existing.supplierData.hotelRunnerFirstFallbackCommercialBridge = {
		version: 1,
		jobId: "64b000000000000000000399",
		inboundEmailId: INBOUND_ID,
		inboundEmailHash: "9".repeat(64),
		normalizedReservationHash: "8".repeat(64),
		resolvedHotelProofHash: "6".repeat(64),
		archiveFingerprint: "7".repeat(64),
		linkedAt: new Date("2026-08-07T15:27:00.000Z"),
	};
	const record = inboundRecord(inbound, {
		intent: "new_reservation",
		eventType: "new",
		emailHash: "9".repeat(64),
		processingStatus: "duplicate_reservation",
		automationAction: "skipped",
		hotelRunnerFirstFallback: {
			status: "completed_api",
			jobId: "64b000000000000000000399",
		},
	});
	const result = await loadHotelRunnerEmailCommercialBridge(
		{ existing, normalized: hotelRunnerNormalized(), provider: "agoda" },
		{ InboundEmailModel: modelFor(record) }
	);
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.amountRole, "payout");
	assert.equal(result.evidence.grossTotalSar, 95.06);
});

test("only the exact Agoda allocation-only review remains usable after API-first finalization", async () => {
	const inbound = authenticatedInbound({
		intent: "new_reservation",
		eventType: "new",
		roomCount: 2,
		requiresManualReview: true,
		ambiguousMultiRoomEvidence: true,
		blocksUnmappedReservationCreation: true,
		manualReviewReasons: [
			"Agoda email contains multiple rooms; automatic partial-room creation is disabled and the booking requires room review.",
		],
	});
	const existing = materializedExisting(inbound);
	existing.supplierData.otaInboundEmailId = INBOUND_ID;
	existing.supplierData.otaAutomationPipeline = "hotelrunner-background-worker";
	existing.supplierData.otaSourceAuthority = 4;
	existing.supplierData.hotelRunner = { transport: "hotelrunner_api" };
	existing.supplierData.hotelRunnerFirstFallbackCommercialBridge = {
		version: 1,
		jobId: "64b000000000000000000399",
		inboundEmailId: INBOUND_ID,
		inboundEmailHash: "9".repeat(64),
		normalizedReservationHash: "8".repeat(64),
		resolvedHotelProofHash: "6".repeat(64),
		archiveFingerprint: "7".repeat(64),
		linkedAt: new Date("2026-08-07T15:27:00.000Z"),
	};
	const record = inboundRecord(inbound, {
		intent: "new_reservation",
		eventType: "new",
		emailHash: "9".repeat(64),
		processingStatus: "duplicate_reservation",
		automationAction: "skipped",
		hotelRunnerFirstFallback: {
			status: "completed_api",
			jobId: "64b000000000000000000399",
		},
	});
	const normalized = hotelRunnerNormalized({
		totalRooms: 2,
		rooms: [{}, {}],
	});
	const accepted = await loadHotelRunnerEmailCommercialBridge(
		{ existing, normalized, provider: "agoda" },
		{ InboundEmailModel: modelFor(record) }
	);
	assert.equal(accepted.ok, true, JSON.stringify(accepted));
	assert.equal(accepted.amountRole, "payout");

	record.normalizedReservation = {
		...inbound,
		manualReviewReasons: ["A different manual review reason."],
	};
	const rejected = await loadHotelRunnerEmailCommercialBridge(
		{ existing, normalized, provider: "agoda" },
		{ InboundEmailModel: modelFor(record) }
	);
	assert.equal(rejected.ok, false);
	assert.equal(rejected.reason, "source_requires_manual_review");
});

test("Mongo ObjectId references are bounded values and never recurse", async () => {
	const inbound = authenticatedInbound();
	const existing = materializedExisting(inbound, {
		_id: new mongoose.Types.ObjectId(RESERVATION_ID),
	});
	existing.supplierData.otaLastInboundEmailId =
		new mongoose.Types.ObjectId(INBOUND_ID);
	const record = inboundRecord(inbound, {
		_id: new mongoose.Types.ObjectId(INBOUND_ID),
		reservationMongoId: new mongoose.Types.ObjectId(RESERVATION_ID),
	});
	const result = await loadHotelRunnerEmailCommercialBridge(
		{ existing, normalized: hotelRunnerNormalized(), provider: "agoda" },
		{ InboundEmailModel: modelFor(record) }
	);
	assert.equal(result.ok, true);
	assert.equal(result.amountRole, "payout");
});

test("queued Trip API creation bridge accepts exact stored-FX evidence and exact PMS room ownership", async () => {
	const fixture = await queuedTripFixture();
	assert.equal(fixture.inbound.exchangeRateSource, "exchange_rate_api_stored");
	assert.deepEqual(
		fixture.inbound.paymentSummary.currencyConversionEvidence,
		fixture.inbound.currencyConversionEvidence
	);
	const jobObservations = {};
	const auditObservations = {};
	const result = await loadHotelRunnerQueuedEmailCommercialBridge(
		{
			normalized: fixture.normalized,
			provider: "trip",
			hotel: fixture.hotel,
			config: fixture.config,
		},
		{
			FallbackJobModel: jobsModelFor([fixture.job], jobObservations),
			InboundEmailModel: modelFor(fixture.audit, auditObservations),
			resolveArchivedHotel: async () => fixture.hotel,
			now: () => new Date("2026-08-09T06:01:00.000Z"),
		}
	);
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.amountRole, "payout");
	assert.equal(result.sourceCurrency, "USD");
	assert.equal(result.sourceAmount, 21.4);
	assert.equal(result.hotelRunnerAmount, 18.2);
	assert.equal(result.grossTotalSar, 81.32);
	assert.equal(result.evidence.payoutTotalSar, 69.16);
	assert.equal(result.jobId, String(fixture.job._id));
	assert.equal(result.inboundEmailId, String(fixture.audit._id));
	assert.equal(jobObservations.projection, HOTELRUNNER_QUEUED_EMAIL_COMMERCIAL_JOB_PROJECTION);
	assert.equal(auditObservations.projection, HOTELRUNNER_QUEUED_EMAIL_COMMERCIAL_AUDIT_PROJECTION);
	for (const forbidden of [
		"bodyText",
		"bodyHtml",
		"subject",
		"attachments",
		"payment_details",
	]) {
		assert.equal(auditObservations.projection.includes(forbidden), false);
	}
	const roomVerified = validateHotelRunnerQueuedEmailCommercialBridgeRooms(
		result,
		{
			hotel: fixture.hotel,
			resolvedRooms: [
				{
					roomDetails: fixture.hotel.roomCountDetails[0],
					mapping: { localRoomConfigId: fixture.roomId },
				},
			],
		}
	);
	assert.equal(roomVerified.ok, true);
});

test("queued Trip bridge rematerializes only a legacy one-cent property-money drift", async () => {
	const fixture = await queuedTripFixture();
	fixture.audit.normalizedReservation = {
		...fixture.inbound,
		amount: 81.31,
		totalAmountSar: 81.31,
		paymentSummary: {
			...fixture.inbound.paymentSummary,
			totalGuestPaymentAmount: 81.31,
		},
	};
	Object.assign(
		fixture.job,
		createArchiveFingerprint({
			identity: {
				hotelId: fixture.config.hotelId,
				provider: "trip",
				confirmationNumber: fixture.job.confirmationNumber,
			},
			audit: fixture.audit,
		})
	);

	const result = await loadHotelRunnerQueuedEmailCommercialBridge(
		{
			normalized: fixture.normalized,
			provider: "trip",
			hotel: fixture.hotel,
			config: fixture.config,
		},
		{
			FallbackJobModel: jobsModelFor([fixture.job]),
			InboundEmailModel: modelFor(fixture.audit),
			resolveArchivedHotel: async () => fixture.hotel,
			now: () => new Date("2026-08-09T06:01:00.000Z"),
		}
	);

	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.evidence.grossTotalSar, 81.32);
	assert.equal(result.normalizedReservation.amount, 81.32);
	assert.equal(result.normalizedReservation.totalAmountSar, 81.32);
	assert.equal(
		result.normalizedReservation.paymentSummary.totalGuestPaymentAmount,
		81.32
	);
	assert.equal(
		fixture.audit.normalizedReservation.paymentSummary.totalGuestPaymentAmount,
		81.31,
		"the immutable archived audit must not be rewritten"
	);

	fixture.audit.normalizedReservation = {
		...fixture.audit.normalizedReservation,
		amount: 81.3,
		totalAmountSar: 81.3,
		paymentSummary: {
			...fixture.audit.normalizedReservation.paymentSummary,
			totalGuestPaymentAmount: 81.3,
		},
	};
	Object.assign(
		fixture.job,
		createArchiveFingerprint({
			identity: {
				hotelId: fixture.config.hotelId,
				provider: "trip",
				confirmationNumber: fixture.job.confirmationNumber,
			},
			audit: fixture.audit,
		})
	);
	const outOfBounds = await loadHotelRunnerQueuedEmailCommercialBridge(
		{
			normalized: fixture.normalized,
			provider: "trip",
			hotel: fixture.hotel,
			config: fixture.config,
		},
		{
			FallbackJobModel: jobsModelFor([fixture.job]),
			InboundEmailModel: modelFor(fixture.audit),
			resolveArchivedHotel: async () => fixture.hotel,
			now: () => new Date("2026-08-09T06:01:00.000Z"),
		}
	);
	assert.equal(outOfBounds.ok, true, JSON.stringify(outOfBounds));
	assert.equal(
		outOfBounds.normalizedReservation.paymentSummary.totalGuestPaymentAmount,
		81.3,
		"a drift larger than one cent must remain untouched and fail closed later"
	);
});

test("a coordinator-owned nonexpired processing job remains eligible for the read-only API bridge", async () => {
	const fixture = await queuedTripFixture();
	fixture.job.status = "processing";
	fixture.job.leaseOwner = "hotelrunner-worker-1";
	fixture.job.leaseToken = "b".repeat(32);
	fixture.job.leaseAcquiredAt = new Date("2026-08-09T06:00:00.000Z");
	fixture.job.leaseUntil = new Date("2026-08-09T06:05:00.000Z");
	fixture.audit.hotelRunnerFirstFallback.status = "recovery_pending";
	const result = await loadHotelRunnerQueuedEmailCommercialBridge(
		{
			normalized: fixture.normalized,
			provider: "trip",
			hotel: fixture.hotel,
			config: fixture.config,
		},
		{
			FallbackJobModel: jobsModelFor([fixture.job]),
			InboundEmailModel: modelFor(fixture.audit),
			resolveArchivedHotel: async () => fixture.hotel,
			now: () => new Date("2026-08-09T06:01:00.000Z"),
		}
	);
	assert.equal(result.ok, true, JSON.stringify(result));
});

test("queued creation bridge rejects terminal, expired, tampered, manual, and room-near-miss evidence without writes", async (t) => {
	const cases = [
		[
			"terminal job",
			"fallback_job_not_active",
			(fixture) => {
				fixture.job.status = "completed_api";
			},
		],
		[
			"expired processing lease",
			"fallback_job_not_active",
			(fixture) => {
				fixture.job.status = "processing";
				fixture.job.leaseOwner = "worker-1";
				fixture.job.leaseToken = "b".repeat(32);
				fixture.job.leaseAcquiredAt = new Date("2026-08-09T05:50:00.000Z");
				fixture.job.leaseUntil = new Date("2026-08-09T05:59:00.000Z");
			},
		],
		[
			"fingerprint",
			"fallback_job_config_mismatch",
			(fixture) => {
				fixture.job.hrIdFingerprint = "0".repeat(64);
			},
		],
		[
			"lookup confirmation hash",
			"fallback_job_identity_mismatch",
			(fixture) => {
				fixture.job.lookupConfirmationHash = "0".repeat(64);
			},
		],
		[
			"archive hash",
			"queued_archive_fingerprint_mismatch",
			(fixture) => {
				fixture.job.archiveFingerprint = "0".repeat(64);
			},
		],
		[
			"source amount",
			"queued_amount_mismatch",
			(fixture) => {
				fixture.normalized.totalCents = 1900;
			},
		],
		[
			"resolved hotel",
			"queued_hotel_mismatch",
			(fixture) => {
				fixture.resolveHotel = async () => ({
					...fixture.hotel,
					_id: "64b000000000000000000499",
				});
			},
		],
		[
			"current hotel proof",
			"queued_hotel_proof_mismatch",
			(fixture) => {
				fixture.hotel.belongsTo = "64b000000000000000000499";
			},
		],
	];
	for (const [name, reason, mutate] of cases) {
		await t.test(name, async () => {
			const fixture = await queuedTripFixture();
			mutate(fixture);
			const result = await loadHotelRunnerQueuedEmailCommercialBridge(
				{
					normalized: fixture.normalized,
					provider: "trip",
					hotel: fixture.hotel,
					config: fixture.config,
				},
				{
					FallbackJobModel: jobsModelFor([fixture.job]),
					InboundEmailModel: modelFor(fixture.audit),
					resolveArchivedHotel:
						fixture.resolveHotel || (async () => fixture.hotel),
					now: () => new Date("2026-08-09T06:01:00.000Z"),
				}
			);
			assert.equal(result.ok, false, name);
			assert.equal(result.reason, reason, name);
		});
	}

	await t.test("manual archive with a self-consistent queue fingerprint", async () => {
		const fixture = await queuedTripFixture();
		fixture.audit.normalizedReservation.requiresManualReview = true;
		const fingerprints = createArchiveFingerprint({
			identity: {
				hotelId: fixture.config.hotelId,
				provider: "trip",
				confirmationNumber: fixture.normalized.providerNumber,
			},
			audit: fixture.audit,
		});
		Object.assign(fixture.job, fingerprints);
		const result = await loadHotelRunnerQueuedEmailCommercialBridge(
			{
				normalized: fixture.normalized,
				provider: "trip",
				hotel: fixture.hotel,
				config: fixture.config,
			},
			{
				FallbackJobModel: jobsModelFor([fixture.job]),
				InboundEmailModel: modelFor(fixture.audit),
				resolveArchivedHotel: async () => fixture.hotel,
				now: () => new Date("2026-08-09T06:01:00.000Z"),
			}
		);
		assert.equal(result.ok, false);
		assert.equal(result.reason, "queued_commercial_evidence_invalid");
	});

	await t.test("room mapping near miss", async () => {
		const fixture = await queuedTripFixture();
		const bridge = await loadHotelRunnerQueuedEmailCommercialBridge(
			{
				normalized: fixture.normalized,
				provider: "trip",
				hotel: fixture.hotel,
				config: fixture.config,
			},
			{
				FallbackJobModel: jobsModelFor([fixture.job]),
				InboundEmailModel: modelFor(fixture.audit),
				resolveArchivedHotel: async () => fixture.hotel,
				now: () => new Date("2026-08-09T06:01:00.000Z"),
			}
		);
		const result = validateHotelRunnerQueuedEmailCommercialBridgeRooms(
			bridge,
			{
				hotel: fixture.hotel,
				resolvedRooms: [
					{
						roomDetails: { _id: "64b000000000000000000498" },
						mapping: { localRoomConfigId: "64b000000000000000000498" },
					},
				],
			}
		);
		assert.equal(result.ok, false);
		assert.equal(result.reason, "queued_room_identity_mismatch");
	});
});

test("same-currency queued Agoda commercial evidence remains eligible for API-first creation", async () => {
	const fixture = await queuedTripFixture();
	const confirmationNumber = "2039878308";
	const inbound = authenticatedInbound({
		inboundEmailId: String(fixture.audit._id),
		provider: "agoda",
		trustedTransportProvider: "agoda",
		confirmationNumber,
		reservationId: confirmationNumber,
		intent: "new_reservation",
		eventType: "new",
		hotelName: "Zad Ajyad",
		roomName: "Double Room",
		checkinDate: "2026-08-09",
		checkoutDate: "2026-08-10",
	});
	fixture.audit.provider = "agoda";
	fixture.audit.confirmationNumber = confirmationNumber;
	fixture.audit.normalizedReservation = inbound;
	fixture.audit.senderAuthentication.trustedProvider = "agoda";
	fixture.job.provider = "agoda";
	fixture.job.lookupConfirmationNumber = confirmationNumber;
	fixture.job.confirmationNumber = confirmationNumber;
	fixture.job.identityKey = `agoda:${confirmationNumber}`;
	Object.assign(
		fixture.job,
		createArchiveFingerprint({
			identity: {
				hotelId: fixture.config.hotelId,
				provider: "agoda",
				confirmationNumber,
			},
			audit: fixture.audit,
		})
	);
	fixture.normalized = {
		...fixture.normalized,
		providerNumber: confirmationNumber,
		channel: "agodaycs5",
		channelDisplay: "Agoda",
		sourceDisplay: "Agoda",
		currency: "SAR",
		totalCents: 5882,
	};
	const result = await loadHotelRunnerQueuedEmailCommercialBridge(
		{
			normalized: fixture.normalized,
			provider: "agoda",
			hotel: fixture.hotel,
			config: fixture.config,
		},
		{
			FallbackJobModel: jobsModelFor([fixture.job]),
			InboundEmailModel: modelFor(fixture.audit),
			resolveArchivedHotel: async () => fixture.hotel,
			now: () => new Date("2026-08-09T06:01:00.000Z"),
		}
	);
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.amountRole, "payout");
	assert.equal(result.evidence.grossTotalSar, 95.06);
	assert.equal(result.evidence.payoutTotalSar, 58.82);
});

test("queued Agoda allocation-only review lets verified HotelRunner mappings own heterogeneous rooms", async () => {
	const fixture = await queuedTripFixture();
	const confirmationNumber = "2039878308";
	const secondRoomId = "64b000000000000000000406";
	const inbound = authenticatedInbound({
		inboundEmailId: String(fixture.audit._id),
		provider: "agoda",
		trustedTransportProvider: "agoda",
		confirmationNumber,
		reservationId: confirmationNumber,
		intent: "new_reservation",
		eventType: "new",
		hotelName: "Zad Ajyad",
		roomName: "Multiple room allocation",
		checkinDate: "2026-08-09",
		checkoutDate: "2026-08-13",
		roomCount: 2,
		amount: 588,
		totalAmountSar: 588,
		sourceAmount: 588,
		totalPayoutSar: 363.78,
		netAfterExpensesTotal: 363.78,
		paymentSummary: {
			sourceCurrency: "SAR",
			sourceTotalGuestPaymentAmount: 588,
			sourceTotalPayoutAmount: 363.78,
			totalGuestPaymentAmount: 588,
			totalPayoutAmount: 363.78,
			currency: "SAR",
			exchangeRateToSar: 1,
			exchangeRateSource: "identity",
		},
		requiresManualReview: true,
		ambiguousMultiRoomEvidence: true,
		blocksUnmappedReservationCreation: true,
		manualReviewReasons: [
			"Agoda email contains multiple rooms; automatic partial-room creation is disabled and the booking requires room review.",
		],
	});
	Object.assign(fixture.audit, {
		provider: "agoda",
		confirmationNumber,
		normalizedReservation: inbound,
		senderAuthentication: {
			authenticatedAligned: true,
			trustedProvider: "agoda",
		},
	});
	Object.assign(fixture.job, {
		provider: "agoda",
		lookupConfirmationNumber: confirmationNumber,
		confirmationNumber,
		identityKey: `agoda:${confirmationNumber}`,
	});
	Object.assign(
		fixture.job,
		createArchiveFingerprint({
			identity: {
				hotelId: fixture.config.hotelId,
				provider: "agoda",
				confirmationNumber,
			},
			audit: fixture.audit,
		})
	);
	fixture.hotel.roomCountDetails.push({
		_id: secondRoomId,
		roomType: "tripleRooms",
		displayName: "Triple Room",
		activeRoom: true,
	});
	fixture.normalized = {
		...fixture.normalized,
		providerNumber: confirmationNumber,
		channel: "agodaycs5",
		channelDisplay: "Agoda",
		sourceDisplay: "Agoda",
		checkoutDate: "2026-08-13",
		totalRooms: 2,
		rooms: [{}, {}],
		currency: "SAR",
		totalCents: 36378,
	};
	const bridge = await loadHotelRunnerQueuedEmailCommercialBridge(
		{
			normalized: fixture.normalized,
			provider: "agoda",
			hotel: fixture.hotel,
			config: fixture.config,
		},
		{
			FallbackJobModel: jobsModelFor([fixture.job]),
			InboundEmailModel: modelFor(fixture.audit),
			resolveArchivedHotel: async () => fixture.hotel,
			now: () => new Date("2026-08-09T06:01:00.000Z"),
		}
	);
	assert.equal(bridge.ok, true, JSON.stringify(bridge));
	assert.equal(bridge.amountRole, "payout");
	assert.equal(bridge.evidence.grossTotalSar, 588);
	assert.equal(bridge.evidence.payoutTotalSar, 363.78);
	const verifiedRooms = validateHotelRunnerQueuedEmailCommercialBridgeRooms(
		bridge,
		{
			hotel: fixture.hotel,
			resolvedRooms: [
				{
					roomDetails: fixture.hotel.roomCountDetails[0],
					mapping: { localRoomConfigId: fixture.roomId },
				},
				{
					roomDetails: fixture.hotel.roomCountDetails[1],
					mapping: { localRoomConfigId: secondRoomId },
				},
			],
		}
	);
	assert.equal(verifiedRooms.ok, true, JSON.stringify(verifiedRooms));
});
