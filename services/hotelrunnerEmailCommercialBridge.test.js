/** @format */

process.env.SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "SG.test";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const {
	HOTELRUNNER_EMAIL_COMMERCIAL_BRIDGE_PROJECTION,
	loadHotelRunnerEmailCommercialBridge,
} = require("./hotelrunnerEmailCommercialBridge");
const {
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
						rootPrice: 50,
						netAfterExpenses: marker.payoutTotalSar,
						otaExpenseAmount: marker.otaExpenseTotalSar,
						platformMargin: 8.82,
						hotelRunnerSourcePrice: marker.payoutTotalSar,
					},
				],
			},
		],
		adminPricing: {
			clientTotal: marker.grossTotalSar,
			rootTotal: 50,
			netAfterExpensesTotal: marker.payoutTotalSar,
			otaExpenseTotal: marker.otaExpenseTotalSar,
			platformMarginTotal: 8.82,
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
	assert.equal(result.grossTotalSar, 70.43);
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
