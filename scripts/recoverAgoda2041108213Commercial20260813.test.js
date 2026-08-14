/** @format */

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ReservationModel = require("../models/reservations");
const HotelDetailsModel = require("../models/hotel_details");

const {
	PROOF_MAX_AGE_MS,
	REPAIR_ID,
	TARGET,
	applyRecovery,
	applyUpdateForProof,
	assertAppliedReservation,
	assertHotelRunnerDisabled,
	assertNoForbiddenHotelRunnerRuntimeModules,
	assertOriginalReservation,
	assertRelayTruth,
	directAuditUpdate,
	hashObject,
	loadScope,
	parseArguments,
	parseProof,
	proofToken,
	recoveryMarker,
	relayTruthSnapshot,
	scopeHashes,
	withOutboundHttpBlocked,
} = require("./recoverAgoda2041108213Commercial20260813");
const {
	hashText,
	reconcileOtaReservation,
} = require("../services/otaReservationMapper");

const PLANNED_AT = new Date("2026-08-14T01:20:00.000Z");
const disabledEnv = () => ({
	HOTELRUNNER_INTEGRATION_ENABLED: "false",
	HOTELRUNNER_PROJECTION_ENABLED: "false",
	HOTELRUNNER_PULL_ENABLED: "false",
	HOTELRUNNER_ROOM_LIST_SYNC_ENABLED: "false",
	HOTELRUNNER_CONFIRM_DELIVERY_ENABLED: "false",
});

const jsonClone = (value) => JSON.parse(JSON.stringify(value));

function fixtureTarget() {
	const directBody = "SYNTHETIC AUTHENTICATED DIRECT AGODA ARCHIVE";
	const relayBody = "SYNTHETIC AUTHENTICATED HOTELRUNNER RELAY ARCHIVE";
	return {
		...TARGET,
		directTextHash: hashText(directBody),
		directEmailHash: "a".repeat(64),
		directDedupeKey: `mid:${"b".repeat(64)}`,
		relayTextHash: hashText(relayBody),
		relayEmailHash: "c".repeat(64),
		relayDedupeKey: `mid:${"d".repeat(64)}`,
		directBody,
		relayBody,
	};
}

function fixtureNormalized(target) {
	const deduction = (type, label, amountSar) => ({
		type,
		label,
		amountSar,
		sourceAmount: amountSar,
		currency: "SAR",
		source: "authenticated_agoda_email",
	});
	return {
		provider: "agoda",
		providerLabel: "Agoda",
		confirmationNumber: target.confirmationNumber,
		reservationId: target.confirmationNumber,
		intent: "new_reservation",
		eventType: "new",
		statusToApply: "confirmed",
		sourceSenderAuthenticated: true,
		sourceSenderTrusted: true,
		trustedTransportProvider: "agoda",
		requiresManualReview: false,
		blocksUnmappedReservationCreation: false,
		ambiguousMultiRoomEvidence: false,
		genericRepeatedFactConflictFields: [],
		hotelName: "Zyd Agyad",
		hotelNameAliases: ["Zyd Agyad"],
		roomName: "Comfort Double - Non-Smoking (Comfort Double Room-)",
		checkinDate: target.checkinDate,
		checkoutDate: target.checkoutDate,
		roomCount: 1,
		adults: 2,
		children: 0,
		totalGuests: 2,
		guestName: "SYNTHETIC TEST GUEST",
		nationality: "Saudi Arabia",
		agodaPropertyId: "90720772",
		agodaHomogeneousRoomQuantity: false,
		amount: target.grossSar,
		currency: "SAR",
		sourceAmount: target.grossSar,
		sourceCurrency: "SAR",
		sourcePayoutAmount: target.payoutSar,
		sourcePayoutCurrency: "SAR",
		totalAmountSar: target.grossSar,
		totalPayoutSar: target.payoutSar,
		netAfterExpensesTotal: target.payoutSar,
		exchangeRateToSar: 1,
		exchangeRateSource: "identity",
		amountConvertedAt: target.directSourceReceivedAt,
		propertyConversionVerified: true,
		otaCommissionSar: target.otaCommissionSar,
		otaCommissionSourceAmount: target.otaCommissionSar,
		otaCommissionCurrency: "SAR",
		otaCommissionSource: "agoda_commission",
		otaDeductionConflict: false,
		otaDeductionComponents: [
			deduction("commission", "Commission", 9.11),
			deduction("growth_program", "Agoda Growth Program", 6.08),
			deduction("tax_on_commission", "Tax on Commission", 2.28),
		],
		targetedPromotionsLabelPresent: true,
		nightlyPricingSar: [
			{
				date: target.checkinDate,
				clientAmountSar: target.grossSar,
				payoutAmountSar: target.payoutSar,
			},
		],
		paymentCollectionModel: "ota_collect",
		paidOnline: true,
		paymentSummary: {
			sourceCurrency: "SAR",
			sourceTotalGuestPaymentAmount: target.grossSar,
			sourceTotalPayoutAmount: target.payoutSar,
			sourceTotalPayoutCurrency: "SAR",
			totalGuestPaymentAmount: target.grossSar,
			totalPayoutAmount: target.payoutSar,
			currency: "SAR",
			exchangeRateToSar: 1,
			exchangeRateSource: "identity",
			amountConvertedAt: target.directSourceReceivedAt,
			propertyCurrency: "SAR",
			propertyConversionVerified: true,
		},
		sourcePresence: {
			provider: true,
			confirmationNumber: true,
			hotelName: true,
			roomName: true,
			checkinDate: true,
			checkoutDate: true,
			roomCount: true,
			adults: true,
			children: true,
			totalGuests: true,
			guestName: true,
			amount: true,
			otaCommission: true,
			paymentCollectionModel: true,
			agodaPropertyId: true,
		},
		source: {
			from: '"agoda.com" <no-reply@agoda.com>',
			subject: "Synthetic Agoda confirmation",
			messageId: "synthetic-direct-message",
			textHash: target.directTextHash,
			receivedAt: target.directSourceReceivedAt,
		},
	};
}

function nullRoom(target) {
	return {
		room_type: target.roomType,
		displayName: target.roomDisplayName,
		hotelRoomConfigId: target.roomConfigId,
		sourceRoomName: "Comfort Double - Non-Smoking (Comfort Double Room-)",
		otaRoomMatchType: target.originalRoomMatchType,
		otaRoomMatchScore: target.originalRoomMatchScore,
		chosenPrice: null,
		count: 1,
		pricingByDay: [
			{
				date: target.checkinDate,
				price: null,
				clientPrice: null,
				mainPrice: null,
				rootPrice: target.rootSar,
				commissionRate: 0,
				totalPriceWithCommission: null,
				totalPriceWithoutCommission: target.rootSar,
				netAfterExpenses: null,
				netAfterOtaExpenses: null,
				otaExpenseAmount: null,
				platformMargin: null,
			},
		],
		totalPriceWithCommission: null,
		hotelShouldGet: target.rootSar,
	};
}

function fixtureReservation(target) {
	const room = nullRoom(target);
	return {
		_id: target.reservationId,
		__v: target.reservationVersion,
		createdAt: new Date(target.reservationCreatedAt),
		updatedAt: new Date(target.reservationUpdatedAt),
		hotelId: target.hotelId,
		belongsTo: target.ownerId,
		reservation_id: target.confirmationNumber,
		confirmation_number: target.pmsConfirmationNumber,
		otaIdentityKey: `agoda:${target.confirmationNumber}`,
		otaCrossTransportIdentityKey: "",
		booking_source: "Agoda",
		customer_details: {
			confirmation_number2: target.confirmationNumber,
			booking_source: "Agoda",
		},
		state: "OTA Platform Review",
		reservation_status: "OTA Platform Review",
		checkin_date: new Date(`${target.checkinDate}T00:00:00.000Z`),
		checkout_date: new Date(`${target.checkoutDate}T00:00:00.000Z`),
		total_rooms: 1,
		total_guests: 2,
		adults: 2,
		children: 0,
		total_amount: null,
		sub_total: target.rootSar,
		commission: 0,
		commission_ota: null,
		currency: "SAR",
		payment: "ota collect - amount unavailable",
		financeStatus: "commercial review required",
		paid_amount: null,
		paid_amount_breakdown: {
			paid_online_via_link: 0,
			paid_at_hotel_cash: 0,
			paid_at_hotel_card: 0,
			paid_to_hotel: 0,
			paid_online_jannatbooking: 0,
			paid_online_other_platforms: null,
			paid_online_via_instapay: 0,
			paid_no_show: 0,
			payment_comments:
				"Agoda collection model reported; property-currency amount unavailable",
		},
		payment_details: { captured: false, onsite_paid_amount: 0 },
		financial_cycle: {
			collectionModel: "provider_collected_unresolved",
			status: "review_required",
			commissionType: "amount",
			commissionValue: 0,
			commissionAmount: 0,
			commissionAssigned: false,
			pmsCollectedAmount: null,
			hotelCollectedAmount: 0,
			hotelPayoutDue: null,
			commissionDueToPms: 0,
			lastUpdatedAt: new Date("2026-08-14T01:09:03.903Z"),
		},
		moneyTransferredToHotel: false,
		commissionPaid: false,
		roomId: [],
		bedNumber: [],
		pickedRoomsType: [room],
		pickedRoomsPricing: [jsonClone(room)],
		adminPricing: {
			mode: "ota_platform_sync",
			clientTotal: null,
			rootTotal: target.rootSar,
			netAfterExpensesTotal: null,
			otaExpenseTotal: null,
			platformMarginTotal: null,
			commercialResolution: "unresolved",
		},
		adminPricingVisibility: {
			rootOnlyForHotelManagement: true,
			source: "ota_email_create",
		},
		ota_financial_summary: {
			show: false,
			clientTotal: null,
			netAfterExpenses: null,
			otaExpenseTotal: null,
			platformProfit: null,
		},
		otaPlatformReview: {
			status: "pending",
			provider: "agoda",
			confirmationNumber: target.confirmationNumber,
			releasedAt: null,
			closedAt: null,
		},
		supplierData: {
			otaProvider: "agoda",
			suppliedBookingNo: target.confirmationNumber,
			otaConfirmationNumber: target.confirmationNumber,
			platformConfirmationNumber: target.confirmationNumber,
			otaSourceAuthority: 1,
			otaSourceAmount: target.payoutSar,
			otaLastSourceReceivedAt: new Date(target.relayLastSourceReceivedAt),
			otaLastEventType: "new",
			otaHotelRoomConfigId: target.roomConfigId,
			otaMatchedRoomName: target.roomDisplayName,
			otaRoomMatchType: target.originalRoomMatchType,
			otaRoomMatchScore: target.originalRoomMatchScore,
			otaPaymentCollectionModel: "ota_collect",
		},
		reservationAuditLog: [],
	};
}

function fixtureHotel(target) {
	return {
		_id: target.hotelId,
		belongsTo: target.ownerId,
		hotelName: "Zyd Agyad",
		hotelName_OtherLanguage: "",
		currency: "SAR",
		activateHotel: true,
		xHotelProActive: true,
		roomCountDetails: [
			{
				_id: target.roomConfigId,
				roomType: target.roomType,
				displayName: target.roomDisplayName,
				displayName_OtherLanguage: "",
				activeRoom: true,
				pricingRate: [
					{
						calendarDate: target.checkinDate,
						rootPrice: target.rootSar,
					},
				],
			},
		],
	};
}

function fixtureAudits(target, normalized) {
	const direct = {
		_id: target.directAuditId,
		__v: target.directAuditVersion,
		source: "sendgrid",
		provider: "agoda",
		confirmationNumber: target.confirmationNumber,
		emailHash: target.directEmailHash,
		textHash: target.directTextHash,
		dedupeKey: target.directDedupeKey,
		bodyText: target.directBody,
		bodyHtml: "",
		from: '"agoda.com" <no-reply@agoda.com>',
		subject: "Synthetic Agoda confirmation",
		messageId: "synthetic-direct-message",
		receivedAt: new Date(target.directAuditReceivedAt),
		createdAt: new Date(target.directAuditCreatedAt),
		updatedAt: new Date(target.directAuditUpdatedAt),
		processingStatus: "needs_review",
		automationAction: "skipped",
		skipReason: "ota_parser_requires_manual_review",
		hasReservationConnection: false,
		reservationMongoId: null,
		senderAuthentication: {
			authenticatedAligned: true,
			dkimAlignedPass: true,
			trustedProvider: "agoda",
			fromDomain: "agoda.com",
			method: "dkim",
		},
		normalizedReservation: {
			source: {
				textHash: target.directTextHash,
				receivedAt: target.directSourceReceivedAt,
			},
		},
	};
	const relay = {
		_id: target.relayAuditId,
		__v: target.relayAuditVersion,
		provider: "agoda",
		confirmationNumber: target.confirmationNumber,
		emailHash: target.relayEmailHash,
		textHash: target.relayTextHash,
		dedupeKey: target.relayDedupeKey,
		bodyText: target.relayBody,
		bodyHtml: "",
		processingStatus: "created",
		automationAction: "created",
		hasReservationConnection: true,
		reservationMongoId: target.reservationId,
		pmsConfirmationNumber: target.pmsConfirmationNumber,
		hotelId: target.hotelId,
		updatedAt: new Date("2026-08-14T01:09:04.100Z"),
		senderAuthentication: {
			authenticatedAligned: true,
			trustedProvider: "hotelrunner",
		},
		reconciliation: { status: "created", source: "email_relay" },
	};
	return { direct, relay, normalized };
}

function query(value) {
	return {
		lean() {
			return this;
		},
		exec: async () => value,
	};
}

function makeFixtureDependencies() {
	const target = fixtureTarget();
	const normalized = fixtureNormalized(target);
	const audits = fixtureAudits(target, normalized);
	const store = {
		direct: audits.direct,
		relay: audits.relay,
		reservation: fixtureReservation(target),
		hotel: fixtureHotel(target),
	};
	const writes = {
		reservation: 0,
		direct: 0,
		relay: 0,
		lastReservationFilter: null,
	};
	const InboundEmail = {
		findById(documentId) {
			return query(
				documentId === target.directAuditId ? store.direct : store.relay
			);
		},
		async updateOne(filter, update) {
			assert.equal(filter._id, target.directAuditId);
			writes.direct += 1;
			store.direct = applyUpdateForProof(store.direct, update);
			return { matchedCount: 1, modifiedCount: 1 };
		},
	};
	const Reservations = {
		findById(documentId) {
			assert.equal(documentId, target.reservationId);
			return query(store.reservation);
		},
		async updateOne(filter, update) {
			writes.reservation += 1;
			writes.lastReservationFilter = filter;
			store.reservation = applyUpdateForProof(store.reservation, update);
			return { matchedCount: 1, modifiedCount: 1 };
		},
	};
	const HotelDetails = {
		findById(documentId) {
			assert.equal(documentId, target.hotelId);
			return query(store.hotel);
		},
	};
	const roomMatch = {
		roomDetails: store.hotel.roomCountDetails[0],
		score: target.originalRoomMatchScore,
		matchType: target.originalRoomMatchType,
		aiRoomMatch: { usedAI: false, skipReason: "deterministic_match" },
		warnings: [],
	};
	const dependencies = {
		env: disabledEnv(),
		InboundEmail,
		Reservations,
		HotelDetails,
		extractNormalizedReservation: () => jsonClone(normalized),
		resolveHotel: async () => store.hotel,
		resolveRoomMatch: () => roomMatch,
	};
	return { target, normalized, store, writes, dependencies };
}

function planForScope(scope) {
	scope.hashes = scopeHashes(scope);
	return {
		plannedAt: new Date(PLANNED_AT),
		planHash: hashObject({ plannedAt: PLANNED_AT, hashes: scope.hashes }),
		scope,
	};
}

function appliedSetFromExpected(expected) {
	const set = {};
	for (const [key, value] of Object.entries(expected)) {
		if (["_id", "__v", "createdAt", "updatedAt", "reservationAuditLog"].includes(key)) {
			continue;
		}
		set[key] = value;
	}
	return set;
}

test("dry-run is the default and apply requires the exact repair ID plus an unexpired proof", () => {
	assert.deepEqual(parseArguments([]), { apply: false, repairId: "", proof: "" });
	assert.throws(
		() => parseArguments(["--proof", `${PLANNED_AT.getTime()}.${"a".repeat(64)}`]),
		/accepted only together/
	);
	assert.throws(
		() =>
			parseArguments([
				"--apply",
				"--repair-id=wrong",
				`--proof=${PLANNED_AT.getTime()}.${"a".repeat(64)}`,
			]),
		/requires --repair-id/
	);
	const options = parseArguments([
		"--apply",
		`--repair-id=${REPAIR_ID}`,
		`--proof=${PLANNED_AT.getTime()}.${"a".repeat(64)}`,
	]);
	assert.equal(options.apply, true);
	assert.equal(
		parseProof(options.proof, new Date(PLANNED_AT.getTime() + 1000)).planHash,
		"a".repeat(64)
	);
	assert.throws(
		() =>
			parseProof(
				options.proof,
				new Date(PLANNED_AT.getTime() + PROOF_MAX_AGE_MS + 1)
			),
		/expired/
	);
});

test("the executable CLI reads its arguments from process.argv", () => {
	const originalArgv = process.argv;
	const proof = `${Date.now()}.${"a".repeat(64)}`;
	try {
		process.argv = [
			process.execPath,
			"scripts/recoverAgoda2041108213Commercial20260813.js",
			"--apply",
			`--repair-id=${REPAIR_ID}`,
			`--proof=${proof}`,
		];
		assert.deepEqual(parseArguments(), {
			apply: true,
			repairId: REPAIR_ID,
			proof,
		});
	} finally {
		process.argv = originalArgv;
	}
});

test("HotelRunner gates and runtime modules fail closed", () => {
	assert.equal(assertHotelRunnerDisabled(disabledEnv()), true);
	assert.throws(
		() =>
			assertHotelRunnerDisabled({
				...disabledEnv(),
				HOTELRUNNER_PULL_ENABLED: "true",
			}),
		/HOTELRUNNER_PULL_ENABLED/
	);
	assert.equal(assertNoForbiddenHotelRunnerRuntimeModules({}), true);
	assert.throws(
		() =>
			assertNoForbiddenHotelRunnerRuntimeModules({
				"/tmp/hotelrunnerClient.js": {},
			}),
		/runtime\/network module/
	);
});

test("the pinned original Reservation snapshot is null-commercial, one-room, and unassigned", () => {
	const { target, store } = makeFixtureDependencies();
	assert.equal(assertOriginalReservation(target, store.reservation), true);
	const drifted = jsonClone(store.reservation);
	drifted.pickedRoomsType[0].pricingByDay[0].clientPrice = target.grossSar;
	drifted.pickedRoomsPricing[0].pricingByDay[0].clientPrice = target.grossSar;
	assert.throws(
		() => assertOriginalReservation(target, drifted),
		/clientPrice is no longer null/
	);
});

test("scope construction uses only the authenticated direct archive and pins relay truth read-only", async () => {
	const { target, store, dependencies } = makeFixtureDependencies();
	const relayBefore = relayTruthSnapshot(target, store.relay);
	const scope = await loadScope(target, dependencies);
	assert.equal(scope.action, "refresh_via_ordinary_ota_reconciler");
	assert.equal(scope.normalized.inboundEmailId, target.directAuditId);
	assert.equal(scope.normalized.totalAmountSar, target.grossSar);
	assert.equal(scope.normalized.totalPayoutSar, target.payoutSar);
	assert.equal(scope.roomMatch.aiRoomMatch.usedAI, false);
	assert.deepEqual(scope.relayTruth, relayBefore);
	assert.deepEqual(assertRelayTruth(target, store.relay), relayBefore);
});

test("normal apply completes the guarded Reservation refresh and direct-audit finalization in one run", async () => {
	const fixture = makeFixtureDependencies();
	const scope = await loadScope(fixture.target, fixture.dependencies);
	const plan = planForScope(scope);
	fixture.dependencies.reconcileOtaReservation = async () => {
		await fixture.dependencies.Reservations.updateOne(
			{
				_id: fixture.target.reservationId,
				__v: fixture.target.reservationVersion,
				updatedAt: new Date(fixture.target.reservationUpdatedAt),
			},
			{
				$set: appliedSetFromExpected(scope.expected),
				$push: { reservationAuditLog: { action: "updated-from-email" } },
				$inc: { __v: 1 },
			}
		);
		return {
			status: "updated",
			reservationId: fixture.target.reservationId,
			matchedReservationBy: [
				"otaIdentityKey",
				"supplierData.otaConfirmationNumber",
			],
		};
	};
	const relayBefore = relayTruthSnapshot(fixture.target, fixture.store.relay);
	const result = await applyRecovery(plan, fixture.dependencies);

	assert.equal(result.action, "refresh_via_ordinary_ota_reconciler");
	assert.equal(fixture.writes.reservation, 1);
	assert.equal(fixture.writes.direct, 1);
	assert.equal(fixture.writes.relay, 0);
	assert.equal(Array.isArray(fixture.writes.lastReservationFilter?.$and), true);
	assert.equal(
		fixture.writes.lastReservationFilter.$and[1].total_amount,
		null
	);
	assert.equal(
		fixture.writes.lastReservationFilter.$and[1].__v,
		fixture.target.reservationVersion
	);
	assert.equal(assertAppliedReservation(fixture.target, fixture.store.reservation), true);
	assert.equal(fixture.store.direct.reconciliation.repairId, REPAIR_ID);
	assert.equal(fixture.store.direct.reservationMongoId, fixture.target.reservationId);
	assert.deepEqual(relayTruthSnapshot(fixture.target, fixture.store.relay), relayBefore);
});

test("the real ordinary reconciler upgrades the exact mapper-generated unresolved OTA-collect baseline", async () => {
	const fixture = makeFixtureDependencies();
	const originals = {
		reservationFindById: ReservationModel.findById,
		reservationFind: ReservationModel.find,
		reservationUpdateOne: ReservationModel.updateOne,
		hotelFindById: HotelDetailsModel.findById,
		hotelFind: HotelDetailsModel.find,
	};
	ReservationModel.findById = (documentId) => {
		assert.equal(String(documentId), fixture.target.reservationId);
		return query(fixture.store.reservation);
	};
	ReservationModel.find = () => ({
		limit() {
			return this;
		},
		select() {
			return this;
		},
		exec: async () => [fixture.store.reservation],
	});
	ReservationModel.updateOne = async (filter, update) => {
		fixture.writes.reservation += 1;
		fixture.writes.lastReservationFilter = filter;
		fixture.store.reservation = applyUpdateForProof(
			fixture.store.reservation,
			update
		);
		return { matchedCount: 1, modifiedCount: 1 };
	};
	HotelDetailsModel.findById = (documentId) => {
		assert.equal(String(documentId), fixture.target.hotelId);
		return query(fixture.store.hotel);
	};
	HotelDetailsModel.find = () => ({
		select() {
			return this;
		},
		lean: async () => [fixture.store.hotel],
		exec: async () => [fixture.store.hotel],
	});

	try {
		const dependencies = {
			...fixture.dependencies,
			Reservations: ReservationModel,
			HotelDetails: HotelDetailsModel,
			reconcileOtaReservation,
		};
		const scope = await loadScope(fixture.target, dependencies);
		const result = await applyRecovery(planForScope(scope), dependencies);
		assert.equal(result.action, "refresh_via_ordinary_ota_reconciler");
		assert.equal(fixture.writes.reservation, 1);
		assert.equal(fixture.writes.direct, 1);
		assert.equal(fixture.writes.relay, 0);
		assert.equal(
			assertAppliedReservation(fixture.target, fixture.store.reservation),
			true
		);
	} finally {
		ReservationModel.findById = originals.reservationFindById;
		ReservationModel.find = originals.reservationFind;
		ReservationModel.updateOne = originals.reservationUpdateOne;
		HotelDetailsModel.findById = originals.hotelFindById;
		HotelDetailsModel.find = originals.hotelFind;
	}
});

test("post-read commercial assertions fail closed on report or evidence alias tampering", async () => {
	const fixture = makeFixtureDependencies();
	const scope = await loadScope(fixture.target, fixture.dependencies);
	const reportTamper = jsonClone(scope.expected);
	reportTamper.ota_financial_summary.netAfterExpenses = 0;
	assert.throws(
		() => assertAppliedReservation(fixture.target, reportTamper),
		/Financial-summary payout changed/
	);
	const evidenceTamper = jsonClone(scope.expected);
	evidenceTamper.supplierData.otaCommercialEvidence.deductionComponents[0].amount.propertyAmount = 1;
	assert.throws(
		() => assertAppliedReservation(fixture.target, evidenceTamper),
		/Commercial-evidence deduction components changed/
	);
});

test("last-moment relay drift stops before the underlying Reservation write", async () => {
	const fixture = makeFixtureDependencies();
	const scope = await loadScope(fixture.target, fixture.dependencies);
	const plan = planForScope(scope);
	fixture.store.relay.processingStatus = "needs_review";
	fixture.dependencies.reconcileOtaReservation = async () => {
		await fixture.dependencies.Reservations.updateOne(
			{ _id: fixture.target.reservationId },
			{
				$set: appliedSetFromExpected(scope.expected),
				$inc: { __v: 1 },
			}
		);
		return {
			status: "updated",
			reservationId: fixture.target.reservationId,
		};
	};
	await assert.rejects(
		applyRecovery(plan, fixture.dependencies),
		/Relay processing truth changed/
	);
	assert.equal(fixture.writes.reservation, 0);
	assert.equal(fixture.writes.direct, 0);
});

test("lost acknowledgement rerun finalizes only the direct audit and the next rerun is a no-op", async () => {
	const fixture = makeFixtureDependencies();
	const firstScope = await loadScope(fixture.target, fixture.dependencies);
	const applied = applyUpdateForProof(fixture.store.reservation, {
		$set: {
			...appliedSetFromExpected(firstScope.expected),
			"supplierData.directOtaArchiveCommercialRecovery": recoveryMarker(
				fixture.target,
				PLANNED_AT
			),
		},
		$inc: { __v: 1 },
	});
	fixture.store.reservation = applied;
	const lostAckScope = await loadScope(fixture.target, fixture.dependencies);
	assert.equal(lostAckScope.action, "finalize_direct_audit_only");
	const lostAckPlan = planForScope(lostAckScope);
	fixture.dependencies.reconcileOtaReservation = async () => {
		throw new Error("ordinary reconciler must not rerun after an applied marker");
	};
	const result = await applyRecovery(lostAckPlan, fixture.dependencies);
	assert.equal(result.action, "finalize_direct_audit_only");
	assert.equal(fixture.writes.reservation, 0);
	assert.equal(fixture.writes.direct, 1);

	const completeScope = await loadScope(fixture.target, fixture.dependencies);
	assert.equal(completeScope.action, "already_applied_noop");
	const complete = await applyRecovery(planForScope(completeScope), fixture.dependencies);
	assert.equal(complete.action, "already_applied_noop");
	assert.equal(fixture.writes.reservation, 0);
	assert.equal(fixture.writes.direct, 1);
});

test("direct-audit finalization contains exact commercial evidence and preserves the relay tuple", async () => {
	const fixture = makeFixtureDependencies();
	const scope = await loadScope(fixture.target, fixture.dependencies);
	const update = directAuditUpdate(
		scope,
		{
			matchedReservationBy: [
				"otaIdentityKey",
				"supplierData.otaConfirmationNumber",
			],
		},
		scope.expected,
		PLANNED_AT
	);
	assert.deepEqual(update.$set.reconciliation.directArchiveEvidence, {
		inboundEmailId: fixture.target.directAuditId,
		emailHash: fixture.target.directEmailHash,
		textHash: fixture.target.directTextHash,
	});
	assert.deepEqual(update.$set.reconciliation.relayEvidencePreserved, {
		inboundEmailId: fixture.target.relayAuditId,
		emailHash: fixture.target.relayEmailHash,
		textHash: fixture.target.relayTextHash,
		reservationId: fixture.target.reservationId,
	});
	assert.equal(update.$set.reconciliation.grossSar, 60.76);
	assert.equal(update.$set.reconciliation.payoutSar, 37.6);
	assert.equal(update.$set.reconciliation.expenseSar, 23.16);
	assert.equal(update.$set.reconciliation.hotelRunnerApiCalls, 0);
});

test("proof token binds the complete dated plan hash", () => {
	const plan = {
		plannedAt: PLANNED_AT,
		planHash: "e".repeat(64),
	};
	assert.equal(
		proofToken(plan),
		`${PLANNED_AT.getTime()}.${"e".repeat(64)}`
	);
});

test("outbound HTTP and fetch are blocked and restored", async () => {
	const originalFetch = globalThis.fetch;
	await assert.rejects(
		withOutboundHttpBlocked(async () => globalThis.fetch("https://example.invalid")),
		(error) => error.code === "RECOVERY_OUTBOUND_NETWORK_BLOCKED"
	);
	assert.equal(globalThis.fetch, originalFetch);
});

test("the dated utility has no direct HotelRunner runtime import or hardcoded generalized mapper behavior", () => {
	const source = fs.readFileSync(
		path.join(__dirname, "recoverAgoda2041108213Commercial20260813.js"),
		"utf8"
	);
	for (const forbidden of [
		"hotelrunnerClient",
		"hotelrunnerReservationAdapter",
		"hotelrunnerWorker",
		"hotelrunnerSyncWorker",
		"hotelrunnerController",
		"hotelrunnerConfig",
	]) {
		assert.equal(
			new RegExp(`require\\([^)]*${forbidden}`, "i").test(source),
			false,
			forbidden
		);
	}
	assert.equal(source.includes("2041108213"), true);
	assert.equal(source.includes("6a7e6ab079505aeca6507358"), true);
});
