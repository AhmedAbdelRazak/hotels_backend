/** @format */

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const https = require("node:https");
const test = require("node:test");

const {
	PROOF_MAX_AGE_MS,
	POLICY_DATE,
	REPAIR_ID,
	TARGETS,
	RecoverySafetyError,
	assertAppliedAuditState,
	assertExpectedReservationShape,
	assertHotelRunnerDisabled,
	assertRequiredIndexes,
	broadConfirmationLookup,
	dateOnly,
	emailFromAudit,
	expectedTripDatedRecoveryEvidence,
	guestKeyHash,
	hashObject,
	inventoryFingerprint,
	loadedForbiddenHotelRunnerModules,
	noNetworkSarConversionOptions,
	parseArguments,
	parseProof,
	plausibleManualCandidates,
	proofToken,
	recoveryMarkerMatches,
	stampRecoveryProvenance,
	terminalLifecycle,
	tripRoundingCorrection,
	withOutboundHttpBlocked,
} = require("./recoverMissedDirectOtaReservations20260813");
const {
	applyDatedRecoveryConversionBoundary,
	buildDatedRecoveryConversionBoundary,
	datedRecoveryBoundaryHash,
} = require("../services/otaReservationMapper");

const PLAN_AT = new Date("2026-08-13T22:00:00.000Z");

test("recovery scope is immutable, exact, and contains no guest PII", () => {
	assert.deepEqual(
		TARGETS.map((target) => `${target.provider}:${target.confirmationNumber}`),
		["agoda:689553735", "agoda:689554695", "trip:1567953939695657"]
	);
	assert.equal(TARGETS.length, 3);
	for (const target of TARGETS) {
		assert.equal(target.roomCount, 2);
		assert.match(target.auditId, /^[a-f0-9]{24}$/);
		for (const field of ["emailHash", "textHash", "messageIdHash", "dedupeKeyHash", "guestKeyHash"]) {
			assert.match(target[field], /^[a-f0-9]{64}$/);
		}
		assert.equal("guestName" in target, false);
		assert.equal("guestPhone" in target, false);
		assert.equal("guestEmail" in target, false);
	}
});

test("apply requires the exact repair ID and an unexpired proof", () => {
	assert.deepEqual(parseArguments([]), { apply: false, repairId: "", proof: "" });
	assert.throws(() => parseArguments(["--proof", `1.${"a".repeat(64)}`]), RecoverySafetyError);
	assert.throws(() => parseArguments(["--apply", "--repair-id=wrong", `--proof=${PLAN_AT.getTime()}.${"a".repeat(64)}`]), /requires --repair-id/);
	const args = parseArguments(["--apply", `--repair-id=${REPAIR_ID}`, `--proof=${PLAN_AT.getTime()}.${"a".repeat(64)}`]);
	assert.equal(args.apply, true);
	const parsed = parseProof(args.proof, new Date(PLAN_AT.getTime() + 1000));
	assert.equal(parsed.plannedAt.toISOString(), PLAN_AT.toISOString());
	assert.throws(() => parseProof(args.proof, new Date(PLAN_AT.getTime() + PROOF_MAX_AGE_MS + 1)), /expired/);
	const plan = { plannedAt: PLAN_AT, planHash: "b".repeat(64) };
	assert.equal(proofToken(plan), `${PLAN_AT.getTime()}.${"b".repeat(64)}`);
});

test("all HotelRunner master and worker gates must be explicitly false", () => {
	const disabled = {
		HOTELRUNNER_INTEGRATION_ENABLED: "false",
		HOTELRUNNER_PROJECTION_ENABLED: "false",
		HOTELRUNNER_PULL_ENABLED: "false",
		HOTELRUNNER_ROOM_LIST_SYNC_ENABLED: "false",
		HOTELRUNNER_CONFIRM_DELIVERY_ENABLED: "false",
	};
	assert.equal(assertHotelRunnerDisabled(disabled), true);
	for (const key of Object.keys(disabled)) {
		assert.throws(() => assertHotelRunnerDisabled({ ...disabled, [key]: "true" }), new RegExp(key));
		assert.throws(() => assertHotelRunnerDisabled({ ...disabled, [key]: "" }), new RegExp(key));
	}
});

test("recovery imports no HotelRunner network/runtime module", () => {
	assert.deepEqual(loadedForbiddenHotelRunnerModules(), []);
	const source = fs.readFileSync(require.resolve("./recoverMissedDirectOtaReservations20260813"), "utf8");
	assert.equal(/require\(["'][^"']*hotelrunner(?:Client|ReservationAdapter|Worker|SyncWorker|Controller|Config)["']\)/i.test(source), false);
});

test("archived body reconstruction strips exactly one subject prefix", () => {
	const audit = {
		subject: "Synthetic OTA subject",
		bodyText: "Synthetic OTA subject\nSynthetic body",
		bodyHtml: "",
		receivedAt: PLAN_AT,
		normalizedReservation: { source: { receivedAt: "2026-08-13T21:00:00.000Z", timestampMethod: "authenticated_dkim_message_date" } },
	};
	const email = emailFromAudit(audit);
	assert.equal(email.text, "Synthetic body");
	assert.equal(email.sourceReceivedAt, "2026-08-13T21:00:00.000Z");
	assert.equal(email.sourceTimestampMethod, "authenticated_dkim_message_date");
});

function syntheticReservation(target, { persisted = true } = {}) {
	const dates = [];
	for (let date = new Date(`${target.checkinDate}T00:00:00.000Z`); date < new Date(`${target.checkoutDate}T00:00:00.000Z`); date = new Date(date.getTime() + 86400000)) {
		dates.push(date.toISOString().slice(0, 10));
	}
	const rows = target.expectedNightGross.map((gross, roomIndex) => {
		const pricingByDay = gross.map((clientPrice, dayIndex) => {
			const netAfterExpenses = target.expectedNightPayout[roomIndex][dayIndex];
			const rootPrice = target.expectedNightRoot[roomIndex][dayIndex];
			return {
				date: dates[dayIndex],
				price: clientPrice,
				clientPrice,
				mainPrice: clientPrice,
				rootPrice,
				commissionRate: 0,
				totalPriceWithCommission: clientPrice,
				totalPriceWithoutCommission: rootPrice,
				netAfterExpenses,
				netAfterOtaExpenses: netAfterExpenses,
				otaExpenseAmount: Number((clientPrice - netAfterExpenses).toFixed(2)),
				platformMargin: Number((netAfterExpenses - rootPrice).toFixed(2)),
			};
		});
		const roomGross = Number(
			pricingByDay
				.reduce((sum, day) => sum + day.totalPriceWithCommission, 0)
				.toFixed(2)
		);
		const roomRoot = Number(
			pricingByDay.reduce((sum, day) => sum + day.rootPrice, 0).toFixed(2)
		);
		return {
			room_type: target.roomType,
			hotelRoomConfigId: target.roomConfigId,
			chosenPrice: Number((roomGross / dates.length).toFixed(2)),
			count: 1,
			pricingByDay,
			totalPriceWithCommission: roomGross,
			hotelShouldGet: roomRoot,
		};
	});
	return {
		_id: "6a7e50000000000000000000",
		hotelId: "6a40b6a1a6efe70450536038",
		belongsTo: "68b74714fb50e159d48c714d",
		reservation_id: target.confirmationNumber,
		otaIdentityKey: `${target.provider}:${target.confirmationNumber}`,
		otaCrossTransportIdentityKey: target.provider === "trip" ? `trip:${target.confirmationNumber}` : "",
		state: "OTA Platform Review",
		reservation_status: "OTA Platform Review",
		currency: "SAR",
		customer_details: { confirmation_number2: target.confirmationNumber },
		checkin_date: persisted ? new Date(`${target.checkinDate}T00:00:00.000Z`) : target.checkinDate,
		checkout_date: persisted ? new Date(`${target.checkoutDate}T00:00:00.000Z`) : target.checkoutDate,
		total_rooms: 2,
		total_guests: target.totalGuests,
		total_amount: target.grossSar,
		sub_total: target.rootSar,
		paid_amount: target.grossSar,
		paid_amount_breakdown: { paid_online_other_platforms: target.grossSar },
		commission: 0,
		commission_ota: target.otaCommissionSar,
		pickedRoomsType: JSON.parse(JSON.stringify(rows)),
		pickedRoomsPricing: rows,
		adminPricing: {
			clientTotal: target.grossSar,
			rootTotal: target.rootSar,
			netAfterExpensesTotal: target.payoutSar,
			otaExpenseTotal: target.expenseSar,
			platformMarginTotal: target.platformMarginSar,
		},
		ota_financial_summary: {
			clientTotal: target.grossSar,
			hotelVisibleAmount: target.rootSar,
			netAfterExpenses: target.payoutSar,
			netAfterOtaExpenses: target.payoutSar,
			otaExpenseTotal: target.expenseSar,
			platformProfit: target.platformMarginSar,
		},
		otaPlatformReview: { status: "pending" },
		roomId: [],
		bedNumber: [],
		availabilitySnapshot: {
			captured: true,
			overbooked: target.expectedOverbooked,
			issueCount: target.expectedOverbooked ? 1 : 0,
		},
		supplierData: {
			otaProvider: target.provider,
			suppliedBookingNo: target.confirmationNumber,
			otaConfirmationNumber: target.confirmationNumber,
			platformConfirmationNumber: target.confirmationNumber,
			otaInboundEmailId: target.auditId,
			otaAmountSar: target.grossSar,
			otaTotalPayoutSar: target.payoutSar,
			otaExpenseTotalSar: target.expenseSar,
			otaPlatformMarginSar: target.platformMarginSar,
			otaRoomMatchType: target.expectedRoomMatchType,
			otaRoomMatchScore: target.expectedRoomMatchScore,
			otaRoomMatchedByModel: "",
			otaRoomMatchReason: "",
			agodaPropertyId: target.propertyId,
			directOtaArchiveRecovery: {
				repairId: REPAIR_ID,
				policyDate: "2026-08-13",
				inboundEmailId: target.auditId,
				provider: target.provider,
				confirmationNumber: target.confirmationNumber,
				emailHash: target.emailHash,
				textHash: target.textHash,
				appliedAt: PLAN_AT,
				ordinaryOtaReconciler: true,
				orderTakerNormalizationUsed: false,
			},
			...(target.provider === "trip"
				? {
					datedRecoveryConversionEvidence:
						expectedTripDatedRecoveryEvidence(target),
				  }
				: {}),
		},
		reservationAuditLog: [{
			repairId: REPAIR_ID,
			inboundEmailId: target.auditId,
			provider: target.provider,
			confirmationNumber: target.confirmationNumber,
		}],
	};
}

test("all three post-recovery shapes use two count-one full-stay rows and exact whole-booking totals", () => {
	for (const target of TARGETS) {
		const reservation = syntheticReservation(target);
		assert.equal(assertExpectedReservationShape(target, reservation, { persisted: true }), true);
		const doubled = JSON.parse(JSON.stringify(reservation));
		doubled.pickedRoomsPricing[0].count = 2;
		doubled.pickedRoomsType[0].count = 2;
		assert.throws(() => assertExpectedReservationShape(target, doubled, { persisted: true }), /count one/);
		const missingNight = JSON.parse(JSON.stringify(reservation));
		missingNight.pickedRoomsPricing[1].pricingByDay.pop();
		missingNight.pickedRoomsType[1].pricingByDay.pop();
		assert.throws(() => assertExpectedReservationShape(target, missingNight, { persisted: true }), /complete stay/);
		const divergent = JSON.parse(JSON.stringify(reservation));
		divergent.pickedRoomsPricing[0].pricingByDay[0].clientPrice += 0.01;
		assert.throws(() => assertExpectedReservationShape(target, divergent, { persisted: true }), /diverged/);
	}
});

test("persisted shapes reject every report-driving nightly alias and room-total drift", () => {
	const target = TARGETS[0];
	const mutations = [
		["price", (reservation) => {
			reservation.pickedRoomsPricing[0].pricingByDay[0].price += 0.01;
			reservation.pickedRoomsType[0].pricingByDay[0].price += 0.01;
		}],
		["mainPrice", (reservation) => {
			reservation.pickedRoomsPricing[0].pricingByDay[0].mainPrice += 0.01;
			reservation.pickedRoomsType[0].pricingByDay[0].mainPrice += 0.01;
		}],
		["totalPriceWithCommission day", (reservation) => {
			reservation.pickedRoomsPricing[0].pricingByDay[0].totalPriceWithCommission += 0.01;
			reservation.pickedRoomsType[0].pricingByDay[0].totalPriceWithCommission += 0.01;
		}],
		["totalPriceWithoutCommission", (reservation) => {
			reservation.pickedRoomsPricing[0].pricingByDay[0].totalPriceWithoutCommission += 0.01;
			reservation.pickedRoomsType[0].pricingByDay[0].totalPriceWithoutCommission += 0.01;
		}],
		["netAfterOtaExpenses", (reservation) => {
			reservation.pickedRoomsPricing[0].pricingByDay[0].netAfterOtaExpenses += 0.01;
			reservation.pickedRoomsType[0].pricingByDay[0].netAfterOtaExpenses += 0.01;
		}],
		["otaExpenseAmount distribution", (reservation) => {
			for (const collection of [reservation.pickedRoomsPricing, reservation.pickedRoomsType]) {
				collection[0].pricingByDay[0].otaExpenseAmount += 0.01;
				collection[0].pricingByDay[1].otaExpenseAmount -= 0.01;
			}
		}],
		["platformMargin distribution", (reservation) => {
			for (const collection of [reservation.pickedRoomsPricing, reservation.pickedRoomsType]) {
				collection[0].pricingByDay[0].platformMargin += 0.01;
				collection[0].pricingByDay[1].platformMargin -= 0.01;
			}
		}],
		["commissionRate", (reservation) => {
			reservation.pickedRoomsPricing[0].pricingByDay[0].commissionRate = 1;
			reservation.pickedRoomsType[0].pricingByDay[0].commissionRate = 1;
		}],
		["room totalPriceWithCommission", (reservation) => {
			reservation.pickedRoomsPricing[0].totalPriceWithCommission += 0.01;
			reservation.pickedRoomsType[0].totalPriceWithCommission += 0.01;
		}],
		["room hotelShouldGet", (reservation) => {
			reservation.pickedRoomsPricing[0].hotelShouldGet += 0.01;
			reservation.pickedRoomsType[0].hotelShouldGet += 0.01;
		}],
		["room chosenPrice", (reservation) => {
			reservation.pickedRoomsPricing[0].chosenPrice += 0.01;
			reservation.pickedRoomsType[0].chosenPrice += 0.01;
		}],
	];
	for (const [label, mutate] of mutations) {
		const reservation = structuredClone(syntheticReservation(target));
		mutate(reservation);
		assert.throws(
			() => assertExpectedReservationShape(target, reservation, { persisted: true }),
			undefined,
			label
		);
	}
});

test("persisted Trip evidence requires the exact complete repair-only boundary", () => {
	const target = TARGETS.find((item) => item.provider === "trip");
	const reservation = syntheticReservation(target);
	const wrongHash = structuredClone(reservation);
	wrongHash.supplierData.datedRecoveryConversionEvidence.tupleHash = "d".repeat(64);
	assert.throws(
		() => assertExpectedReservationShape(target, wrongHash, { persisted: true }),
		/tuple hash changed/
	);
	const changedTuple = structuredClone(reservation);
	changedTuple.supplierData.datedRecoveryConversionEvidence.historicalArchiveTuple.legacyGrossSar = 372.81;
	assert.throws(
		() => assertExpectedReservationShape(target, changedTuple, { persisted: true }),
		/boundary changed/
	);
});

test("Trip exact-decimal recovery corrects legacy binary rounding by one halalah", () => {
	const trip = TARGETS.find((target) => target.provider === "trip");
	assert.equal(trip.sourceGross, 99.42);
	assert.equal(trip.exchangeRateToSar, 3.75);
	assert.equal(trip.grossSar, 372.83);
	assert.equal(trip.payoutSar, 352.13);
	assert.equal(trip.expenseSar, 20.7);
	assert.deepEqual(trip.expectedNightGross, [[60.23, 60.23, 65.97], [60.22, 60.22, 65.96]]);
	assert.deepEqual(trip.expectedNightPayout, [[56.89, 56.89, 62.29], [56.89, 56.89, 62.28]]);
	assert.deepEqual(tripRoundingCorrection(trip), {
		sourceGross: 99.42,
		sourceCurrency: "USD",
		exchangeRateToSar: 3.75,
		legacySkippedAuditSar: 372.82,
		recoveredExactDecimalSar: 372.83,
		deltaSar: 0.01,
		arithmetic: "decimal_half_up",
	});
});

function exactTripRecoverySource() {
	const target = TARGETS.find((item) => item.provider === "trip");
	return {
		provider: "trip",
		confirmationNumber: target.confirmationNumber,
		inboundEmailId: target.auditId,
		sourceSenderAuthenticated: true,
		sourceSenderTrusted: true,
		trustedTransportProvider: "trip",
		sourceAmount: 99.42,
		sourceCurrency: "USD",
		source: {
			textHash: target.textHash,
			receivedAt: target.sourceReceivedAt,
		},
		paymentSummary: {
			sourceCurrency: "USD",
			sourceTotalGuestPaymentAmount: 99.42,
			sourceTotalPayoutAmount: 93.9,
			sourceTotalPayoutCurrency: "USD",
		},
		nightlyPricingSource: [
			{ date: "2026-08-12", clientAmount: 32.12, payoutAmount: 30.34, currency: "USD" },
			{ date: "2026-08-13", clientAmount: 32.12, payoutAmount: 30.34, currency: "USD" },
			{ date: "2026-08-14", clientAmount: 35.18, payoutAmount: 33.22, currency: "USD" },
		],
	};
}

function exactHistoricalTripTuple() {
	return {
		sourceCurrency: "USD",
		sourceGross: 99.42,
		sourcePayout: 93.9,
		storedExchangeRateToSar: 3.75,
		storedExchangeRateSource: "exchange_rate_api_cached",
		amountConvertedAt: "2026-08-08T19:31:30.244Z",
		sourceReceivedAt: "2026-08-08T19:31:24.000Z",
		legacyGrossSar: 372.82,
		legacyPayoutSar: 352.13,
	};
}

test("Trip repair-specific archive tuple converts offline without fabricating ordinary evidence", () => {
	const source = exactTripRecoverySource();
	const target = TARGETS.find((item) => item.provider === "trip");
	const boundary = buildDatedRecoveryConversionBoundary(source, {
		emailHash: target.emailHash,
		historicalArchiveTuple: exactHistoricalTripTuple(),
	});
	assert.equal(boundary.tupleHash, datedRecoveryBoundaryHash(boundary));
	assert.equal(boundary.trustedForOrdinaryAutomation, false);
	assert.equal(boundary.networkUsed, false);
	const converted = applyDatedRecoveryConversionBoundary(source, boundary);
	assert.equal(converted.totalAmountSar, 372.83);
	assert.equal(converted.totalPayoutSar, 352.13);
	assert.deepEqual(converted.nightlyPricingSar.map((row) => row.clientAmountSar), [120.45, 120.45, 131.93]);
	assert.deepEqual(converted.nightlyPricingSar.map((row) => row.payoutAmountSar), [113.78, 113.78, 124.57]);
	assert.equal("currencyConversionEvidence" in converted, false);
	assert.equal("currencyConversionEvidence" in converted.paymentSummary, false);
});

test("Trip dated boundary rejects boolean bypasses, wrong identity, hash, rate, and output", () => {
	const source = exactTripRecoverySource();
	const target = TARGETS.find((item) => item.provider === "trip");
	const boundary = buildDatedRecoveryConversionBoundary(source, {
		emailHash: target.emailHash,
		historicalArchiveTuple: exactHistoricalTripTuple(),
	});
	assert.throws(() => applyDatedRecoveryConversionBoundary(source, true), /boundary is invalid/);
	assert.throws(() => buildDatedRecoveryConversionBoundary({ ...source, confirmationNumber: "synthetic-other" }, {
		emailHash: target.emailHash,
		historicalArchiveTuple: exactHistoricalTripTuple(),
	}), /one approved archive/);
	assert.throws(() => buildDatedRecoveryConversionBoundary(source, {
		emailHash: "f".repeat(64),
		historicalArchiveTuple: exactHistoricalTripTuple(),
	}), /email hash changed/);
	const wrongRate = { ...exactHistoricalTripTuple(), storedExchangeRateToSar: 3.76 };
	assert.throws(() => buildDatedRecoveryConversionBoundary(source, {
		emailHash: target.emailHash,
		historicalArchiveTuple: wrongRate,
	}), /historical archive exchange tuple changed/);
	const changedOutput = JSON.parse(JSON.stringify(boundary));
	changedOutput.deterministicOutput.grossSar = 372.82;
	changedOutput.tupleHash = datedRecoveryBoundaryHash(changedOutput);
	assert.throws(() => applyDatedRecoveryConversionBoundary(source, changedOutput), /boundary fields or tuple hash changed/);
	const changedSource = { ...source, sourceAmount: 99.41 };
	assert.throws(() => applyDatedRecoveryConversionBoundary(changedSource, boundary), /freshly parsed authenticated Trip archive/);
});

test("manual duplicate screening is provider-identity independent and PII-safe", () => {
	const target = { ...TARGETS[0], guestKeyHash: guestKeyHash("SYNTHETIC PRIMARY GUEST") };
	const candidates = plausibleManualCandidates(target, [{
		_id: "6a7e50000000000000000001",
		customer_details: { name: "SYNTHETIC PRIMARY GUEST" },
		total_rooms: 2,
		pickedRoomsPricing: [],
	}]);
	assert.deepEqual(candidates, [{
		reservationId: "6a7e50000000000000000001",
		reasons: ["same_hotel", "same_stay", "same_normalized_primary_guest", "same_room_count"],
	}]);
	assert.equal(JSON.stringify(candidates).includes("SYNTHETIC PRIMARY GUEST"), false);
	const queryText = JSON.stringify(broadConfirmationLookup(TARGETS[0]));
	for (const field of ["reservation_id", "confirmation_number", "confirmation_number2", "suppliedBookingNo", "otaConfirmationNumber", "platformConfirmationNumber"]) {
		assert.ok(queryText.includes(field));
	}
});

test("lost-ack provenance is exact and stamping is idempotent", () => {
	const target = TARGETS[1];
	const document = syntheticReservation(target, { persisted: false });
	delete document.supplierData.directOtaArchiveRecovery;
	document.reservationAuditLog = [];
	stampRecoveryProvenance(target, document, PLAN_AT);
	stampRecoveryProvenance(target, document, PLAN_AT);
	assert.equal(recoveryMarkerMatches(target, document), true);
	assert.equal(document.reservationAuditLog.filter((entry) => entry.repairId === REPAIR_ID).length, 1);
	assert.equal(document.supplierData.directOtaArchiveRecovery.appliedAt.toISOString(), PLAN_AT.toISOString());
});

test("applied audit idempotence requires the full dated recovery tuple", () => {
	const target = TARGETS.find((item) => item.provider === "trip");
	const reservationId = "6a7e50000000000000000002";
	const pmsConfirmationNumber = "synthetic-pms-confirmation";
	const audit = {
		provider: target.provider,
		confirmationNumber: target.confirmationNumber,
		processingStatus: "created",
		automationAction: "created",
		skipReason: "",
		hasReservationConnection: true,
		reservationMongoId: reservationId,
		hotelId: "6a40b6a1a6efe70450536038",
		pmsConfirmationNumber,
		sourceAmount: target.sourceGross,
		sourceCurrency: target.sourceCurrency,
		totalAmountSar: target.grossSar,
		exchangeRateToSar: target.exchangeRateToSar,
		processedAt: PLAN_AT,
		normalizedReservation: {
			provider: target.provider,
			confirmationNumber: target.confirmationNumber,
			checkinDate: target.checkinDate,
			checkoutDate: target.checkoutDate,
			roomCount: target.roomCount,
			totalGuests: target.totalGuests,
			totalAmountSar: target.grossSar,
			totalPayoutSar: target.payoutSar,
			inboundEmailId: target.auditId,
			source: { textHash: target.textHash },
			datedRecoveryConversionEvidence:
				expectedTripDatedRecoveryEvidence(target),
		},
		orchestratorDecision: {
			usedAI: false,
			skipped: true,
			skipReason: "dated_authenticated_archive_recovery",
			repairId: REPAIR_ID,
			policyDate: POLICY_DATE,
		},
		reconciliation: {
			status: "created",
			actionTaken: "created",
			reservationId,
			hotelId: "6a40b6a1a6efe70450536038",
			pmsConfirmationNumber,
			repairId: REPAIR_ID,
			policyDate: POLICY_DATE,
			recoveredFromInboundAudit: true,
			ordinaryOtaReconciler: true,
			orderTakerNormalizationUsed: false,
			directArchiveEvidence: {
				inboundEmailId: target.auditId,
				emailHash: target.emailHash,
				textHash: target.textHash,
			},
			tripGrossRoundingCorrection: tripRoundingCorrection(target),
		},
	};
	assert.equal(assertAppliedAuditState(target, audit), undefined);
	const tampered = structuredClone(audit);
	tampered.reconciliation.directArchiveEvidence.textHash = "f".repeat(64);
	assert.throws(() => assertAppliedAuditState(target, tampered), /evidence tuple changed/);
	const tamperedBoundary = structuredClone(audit);
	tamperedBoundary.normalizedReservation.datedRecoveryConversionEvidence.deterministicOutput.grossSar = 372.82;
	assert.throws(
		() => assertAppliedAuditState(target, tamperedBoundary),
		/boundary changed/
	);
});

test("terminal lifecycle detection fails closed", () => {
	for (const value of ["cancelled", "canceled", "no_show", "no-show"]) {
		assert.equal(terminalLifecycle({ eventType: value }), true);
	}
	assert.equal(terminalLifecycle({ eventType: "new", statusToApply: "confirmed" }), false);
});

test("required Mongo unique indexes must retain their exact safety contracts", () => {
	assert.equal(assertRequiredIndexes([
		{ name: "uniq_ota_identity_key", key: { otaIdentityKey: 1 }, unique: true, partialFilterExpression: { otaIdentityKey: { $type: "string", $gt: "" } } },
		{ name: "uniq_ota_cross_transport_identity_key", key: { otaCrossTransportIdentityKey: 1 }, unique: true, partialFilterExpression: { otaCrossTransportIdentityKey: { $type: "string", $gt: "" } } },
	], [
		{ name: "uniq_inbound_email_dedupe_key", key: { dedupeKey: 1 }, unique: true, partialFilterExpression: { dedupeKey: { $type: "string", $gt: "" } } },
	]), true);
	assert.throws(() => assertRequiredIndexes([], []), /index is missing/);
	assert.throws(() => assertRequiredIndexes([
		{ name: "uniq_ota_identity_key", key: { otaIdentityKey: 1 }, unique: true, partialFilterExpression: { otaIdentityKey: { $type: "string", $gt: "" } } },
		{ name: "uniq_ota_cross_transport_identity_key", key: { otaCrossTransportIdentityKey: 1 }, unique: true, partialFilterExpression: { otaCrossTransportIdentityKey: { $type: "string", $gt: "" } } },
	], [
		{ name: "uniq_inbound_email_dedupe_key", key: { dedupeKey: 1 }, unique: true, partialFilterExpression: { dedupeKey: { $type: "string" } } },
	]), /dedupe index scope changed/);
});

test("outbound HTTP is blocked for the apply boundary and restored afterward", async () => {
	const original = https.request;
	const originalFetch = globalThis.fetch;
	await assert.rejects(() => withOutboundHttpBlocked(async () => https.request("https://example.invalid")), /Outbound HTTP is disabled/);
	assert.equal(https.request, original);
	await assert.rejects(() => withOutboundHttpBlocked(async () => globalThis.fetch("https://example.invalid")), /Outbound HTTP is disabled/);
	assert.equal(globalThis.fetch, originalFetch);
});

test("ordinary reconciler receives an explicit exchange-rate network tripwire", async () => {
	const options = noNetworkSarConversionOptions();
	assert.equal(options.cache instanceof Map, true);
	await assert.rejects(() => options.fetchImpl(), /exchange-rate network lookup/);
	const mapperSource = fs.readFileSync(require.resolve("../services/otaReservationMapper"), "utf8");
	assert.match(mapperSource, /options\?\.sarConversionOptions \|\| \{\}/);
});

test("date and plan hashing are deterministic for BSON Dates and built date strings", () => {
	assert.equal(dateOnly(new Date("2026-08-20T00:00:00.000Z")), "2026-08-20");
	assert.equal(dateOnly("2026-08-20"), "2026-08-20");
	assert.equal(hashObject({ b: 2, a: 1 }), hashObject({ a: 1, b: 2 }));
});

test("inventory proof binds the complete nonvolatile snapshot, issues, and warnings", () => {
	const inventory = {
		allowed: true,
		issues: [{
			code: "inventory_overbook",
			date: "2026-08-20",
			capacity: 2,
			reserved: 2,
			available: 0,
			requested: 2,
			room_type: "doubleRooms",
			message: "Synthetic safe inventory issue",
		}],
		warnings: [{
			code: "inventory_overbook_override",
			date: "2026-08-20",
			capacity: 2,
			reserved: 2,
			available: 0,
			requested: 2,
			room_type: "doubleRooms",
			message: "Synthetic safe inventory warning",
		}],
		message: "Synthetic safe inventory issue",
		availabilitySnapshot: {
			captured: false,
			capturedAt: null,
			stayDates: ["2026-08-20", "2026-08-21"],
			overbooked: true,
			issueCount: 1,
			rooms: [{
				room_type: "doubleRooms",
				capacity: 2,
				requested: 2,
				minAvailableBeforeRaw: 0,
				minAvailableAfterRaw: -2,
				days: [
					{ date: "2026-08-20", capacity: 2, reservedBefore: 2, availableBeforeRaw: 0, requested: 2, availableAfterRaw: -2 },
					{ date: "2026-08-21", capacity: 2, reservedBefore: 1, availableBeforeRaw: 1, requested: 2, availableAfterRaw: -1 },
				],
			}],
		},
	};
	const laterCapture = structuredClone(inventory);
	laterCapture.availabilitySnapshot.capturedAt = "2026-08-13T23:59:59.999Z";
	assert.deepEqual(
		inventoryFingerprint(laterCapture),
		inventoryFingerprint(inventory),
		"capturedAt is the sole excluded volatile field"
	);
	for (const mutate of [
		(value) => { value.availabilitySnapshot.rooms[0].days[1].reservedBefore = 2; },
		(value) => { value.availabilitySnapshot.rooms[0].days[1].date = "2026-08-22"; },
		(value) => { value.issues[0].capacity = 3; },
		(value) => { value.warnings[0].code = "changed_warning"; },
	]) {
		const changed = structuredClone(inventory);
		mutate(changed);
		assert.notDeepEqual(inventoryFingerprint(changed), inventoryFingerprint(inventory));
	}
});
