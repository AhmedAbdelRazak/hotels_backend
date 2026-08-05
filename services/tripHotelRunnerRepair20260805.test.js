/** @format */

"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ObjectId } = require("bson");

const {
	ALL_AUDIT_IDS,
	EXCLUDED_PMS_CONFIRMATION,
	EXPECTED_HOTEL_ID,
	OPERATION,
	PAYMENT_COMMENT,
	PAYMENT_INSTRUCTIONS,
	SOURCE_CLIENT_TOTAL_SOURCE,
	TARGETS,
	applyUpdateToDocument,
	buildBackupCollectionName,
	buildBackupRecords,
	buildDryRunReport,
	buildRepairPlans,
	canonicalEjsonSha256,
	canonicalEqual,
	cloneBson,
	hasCaptureEvidence,
	parseCliArguments,
	transactionSupportFromHello,
	validateAuditSet,
	verifyBackupRecords,
} = require("./tripHotelRunnerRepair20260805");
const {
	CROSS_TRANSPORT_INDEX_KEY,
	CROSS_TRANSPORT_INDEX_NAME,
	CROSS_TRANSPORT_INDEX_PARTIAL,
	applyWithoutTransaction,
	classifyRollbackState,
	comparePlannedAndSavedBackups,
	ensureCrossTransportIndex,
	inspectCrossTransportIndex,
	loadScope,
	main,
	rollbackClaimStates,
	rollbackManifestClaimFilter,
	updateOnePlan,
	validateManifest,
} = require("../scripts/repairTripHotelRunnerReservations20260805");

const REPAIR_AT = new Date("2026-08-05T06:07:08.901Z");
const REPAIR_ID = "trip-20260805-unit-test";
const BACKUP_COLLECTION = buildBackupCollectionName(REPAIR_ID, REPAIR_AT);

const oldDailyRows = (target) =>
	target.daily.map((expected, index) => {
		const isLongStayTail = target.nights === 6 && index >= 4;
		const oldClient = target.nights === 1 ? 56.89 : isLongStayTail ? 57.78 : 57.79;
		const oldExpense = target.nights === 1 ? 11.38 : isLongStayTail ? 11.55 : 11.56;
		return {
			date: expected.date,
			price: oldClient,
			clientPrice: oldClient,
			mainPrice: oldClient,
			rootPrice: 75,
			commissionRate: 20,
			totalPriceWithCommission: oldClient,
			totalPriceWithoutCommission: 75,
			netAfterExpenses: target.nights === 1 ? 45.51 : 46.23,
			netAfterOtaExpenses: target.nights === 1 ? 45.51 : 46.23,
			otaExpenseAmount: oldExpense,
			platformMargin: target.nights === 1 ? -29.49 : -28.77,
		};
	});

const reservationFixture = (target) => {
	const room = {
		room_type: target.roomType,
		displayName: "Double Room – Comfort & Relaxation",
		hotelRoomConfigId: new ObjectId(target.roomConfigId),
		sourceRoomName:
			target.nights === 1
				? "Comfort Double Room - Zad Ajyad - Bus to Haram - Non-Refundable-Room Only-Prepay | Comfort Double Room - AJIAD Hotel - Free Bus"
				: "arrival-Room Only-Prepay | Comfort Double Room - AJIAD Hotel - Free Bus",
		otaRoomMatchType: "explicit_capacity",
		otaRoomMatchScore: 0.98,
		chosenPrice: target.old.chosenPrice,
		count: 1,
		pricingByDay: oldDailyRows(target),
		totalPriceWithCommission: target.old.clientSar,
		hotelShouldGet: target.corrected.rootSar,
	};
	return {
		_id: new ObjectId(target.mongoId),
		reservation_id: target.otaConfirmation,
		confirmation_number: target.pmsConfirmation,
		otaIdentityKey: target.otaIdentityKey,
		booking_source: "hotelrunner",
		customer_details: {
			booking_source: "HotelRunner",
			name: "Offline fixture guest",
			confirmation_number2: target.otaConfirmation,
		},
		pickedRoomsType: [cloneBson(room)],
		pickedRoomsPricing: [cloneBson(room)],
		total_rooms: 1,
		booked_at: new Date(`${target.bookedAt}T00:00:00.000Z`),
		sub_total: target.corrected.rootSar,
		total_amount: target.old.clientSar,
		currency: "sar",
		checkin_date: new Date(`${target.checkinDate}T00:00:00.000Z`),
		checkout_date: new Date(`${target.checkoutDate}T00:00:00.000Z`),
		days_of_residence: target.nights,
		reservation_status: "confirmed",
		state: "confirmed",
		financeStatus: "not paid",
		payment: "credit/ debit",
		payment_details: {
			captured: false,
			onsite_paid_amount: 0,
		},
		vcc_payment: {
			source: "hotelrunner",
			metadata: { card_last4: target.falseCardLast4 },
		},
		bofa_payment: {
			secure_acceptance: {
				status: "not_started",
				last_reference_number: "",
				last_transaction_id: "",
				callbacks: [],
			},
			vcc: {
				charged: false,
				processing: false,
				charge_count: 0,
				attempts_count: 0,
				failed_attempts_count: 0,
				total_captured_usd: 0,
				total_captured_sar: 0,
				last_transaction_id: "",
				attempts: [],
			},
		},
		paid_amount: 0,
		commissionPaid: false,
		moneyTransferredToHotel: false,
		adminChangeLog: [],
		paid_amount_breakdown: {
			paid_online_via_link: 0,
			paid_at_hotel_cash: 0,
			paid_at_hotel_card: 0,
			paid_to_hotel: 0,
			paid_online_jannatbooking: 0,
			paid_online_other_platforms: 0,
			paid_online_via_instapay: 0,
			paid_no_show: 0,
			payment_comments: "HotelRunner virtual card pending capture",
		},
		commission: target.corrected.commissionSar,
		financial_cycle: {
			collectionModel: "pending",
			status: "open",
			commissionType: "amount",
			commissionValue: target.corrected.commissionSar,
			commissionAmount: target.corrected.commissionSar,
			commissionAssigned: false,
			pmsCollectedAmount: 0,
			hotelCollectedAmount: 0,
			hotelPayoutDue: 0,
			commissionDueToPms: 0,
			lastUpdatedAt: new Date(target.createdAt),
		},
		adminPricing: {
			mode: "ota_platform_sync",
			clientTotal: target.old.clientSar,
			rootTotal: target.corrected.rootSar,
			netAfterExpensesTotal: target.old.netSar,
			otaExpenseTotal: target.old.expenseSar,
			platformMarginTotal: target.old.marginSar,
			commissionAmount: target.corrected.commissionSar,
			defaultDeductionRate: 0.2,
			defaultDeductionApplied: true,
			source: "ota_email_create",
			provider: "hotelrunner",
			providerLabel: "HotelRunner",
			sourceCurrency: "USD",
			sourceAmount: target.old.sourceUsd,
			sourceExchangeRateToSar: 3.75,
			sourceExchangeRateSource: "fallback_default",
			exchangeRateToSar: 3.75,
			exchangeRateSource: "fallback_default",
			amountConvertedAt: new Date(
				target.exchange.adminAmountConvertedAt,
			),
			payoutFallbackReason: "",
		},
		hotelId: new ObjectId(EXPECTED_HOTEL_ID),
		supplierData: {
			supplierName: "HotelRunner",
			suppliedBookingNo: target.otaConfirmation,
			otaConfirmationNumber: target.otaConfirmation,
			platformConfirmationNumber: target.otaConfirmation,
			otaAutomationPipeline: "ota-email-orchestrator",
			otaProvider: "hotelrunner",
			otaSourceAuthority: 1,
			otaMatchedRoomName: "Double Room – Comfort & Relaxation",
			otaHotelRoomConfigId: new ObjectId(target.roomConfigId),
			otaSourceRoomName: room.sourceRoomName,
			otaRoomMatchScore: 0.98,
			otaRoomMatchType: "explicit_capacity",
			otaCurrency: "USD",
			otaAmount: target.old.sourceUsd,
			otaAmountSar: target.old.clientSar,
			otaSourceCurrency: "USD",
			otaSourceAmount: target.old.sourceUsd,
			otaSourceExchangeRateToSar: 3.75,
			otaSourceExchangeRateSource: "fallback_default",
			otaPaymentSummary: {
				sourceCurrency: "USD",
				sourceTotalGuestPaymentAmount: target.old.sourceUsd,
				sourceTotalPayoutAmount: 0,
				totalGuestPaymentAmount: target.old.clientSar,
				totalPayoutAmount: 0,
				currency: "SAR",
				exchangeRateToSar: 3.75,
				exchangeRateSource: "fallback_default",
				amountConvertedAt: new Date(
					target.exchange.paymentAmountConvertedAt,
				),
			},
			otaPayoutFallbackReason: "",
			otaTotalPayoutSar: target.old.netSar,
			otaExpenseTotalSar: target.old.expenseSar,
			otaPlatformMarginSar: target.old.marginSar,
			otaExchangeRateToSar: 3.75,
			otaExchangeRateSource: "exchange_rate_api_cached",
			otaAmountConvertedAt: new Date(
				target.exchange.adminAmountConvertedAt,
			),
			otaPaymentCollectionModel: "virtual_card",
			otaPaymentInstructions: "virtual_card",
			pmsConfirmationNumber: target.pmsConfirmation,
			otaCreatedFromEmail: true,
			otaCreatedFromSync: false,
		},
		otaPlatformReview: {
			status: "pending",
			source: "ota_email_create",
			provider: "hotelrunner",
			providerLabel: "HotelRunner",
			confirmationNumber: target.otaConfirmation,
			releasedAt: null,
			priceAtRelease: 0,
		},
		adminLastUpdatedAt: null,
		reservationAuditLog: [
			{
				at: new Date(target.createdAt),
				action: "created-from-email",
				provider: "hotelrunner",
				reservationId: target.otaConfirmation,
			},
		],
		createdAt: new Date(target.createdAt),
		updatedAt: new Date(target.updatedAt),
		__v: 0,
	};
};

const auditFixtures = () =>
	TARGETS.flatMap((target) =>
		target.audits.map((expected) => {
			const direct = expected.role === "direct_trip_commercial_evidence";
			const duplicate =
				expected.role === "duplicate_relay_no_mutation_authority";
			return {
				_id: new ObjectId(expected.id),
				provider: expected.provider,
				providerLabel: direct ? "Trip.com" : "HotelRunner",
				textHash: expected.textHash,
				emailHash: expected.emailHash,
				from: direct
					? "noreply_htl@trip.com"
					: '"HotelRunner" <noreply@hotelrunner.com>',
				automationAction:
					direct || duplicate ? "skipped" : "created",
				skipReason: duplicate
					? "duplicate_email"
					: direct
						? "ota_manual_review_no_reservation_created"
						: "",
				confirmationNumber: target.otaConfirmation,
				pmsConfirmationNumber: direct ? "" : target.pmsConfirmation,
				reservationMongoId: direct ? null : new ObjectId(target.mongoId),
				hasReservationConnection: !direct,
				processingStatus: direct
					? "needs_review"
					: duplicate
						? "duplicate_email"
						: "created",
				duplicateOf: duplicate
					? new ObjectId(target.audits[1].id)
					: null,
				subject: direct
					? `Booking no. #${target.otaConfirmation}# accepted`
					: "Zad AJYAD Hotel - new reservation",
				bodyText: "Stored historical source; deliberately never replayed by repair tests.",
				receivedAt: new Date(expected.receivedAt),
				processedAt: new Date(expected.processedAt),
			};
		}),
	);

const fixtureSet = () => ({
	reservations: TARGETS.map(reservationFixture),
	audits: auditFixtures(),
});

const context = () => ({
	repairId: REPAIR_ID,
	repairAt: REPAIR_AT,
	backupCollection: BACKUP_COLLECTION,
});

test("incident scope is immutable, complete, and excludes the manually handled reservation", () => {
	assert.deepEqual(
		TARGETS.map((target) => target.pmsConfirmation),
		["8234871006", "9764914393"],
	);
	assert.deepEqual(
		TARGETS.map((target) => target.mongoId),
		["6a727710c0900e055a1b83ba", "6a7289cbc0900e055a1b8b9e"],
	);
	assert.equal(ALL_AUDIT_IDS.length, 6);
	assert.equal(new Set(ALL_AUDIT_IDS).size, 6);
	assert.equal(
		TARGETS.some(
			(target) => target.pmsConfirmation === EXCLUDED_PMS_CONFIRMATION,
		),
		false,
	);
});

test("canonical EJSON SHA-256 is key-order stable and BSON-sensitive", () => {
	const objectId = new ObjectId("6a727710c0900e055a1b83ba");
	const first = {
		z: new Date("2026-08-05T00:00:00.000Z"),
		a: { y: 2, x: objectId },
	};
	const reordered = {
		a: { x: new ObjectId(String(objectId)), y: 2 },
		z: new Date("2026-08-05T00:00:00.000Z"),
	};
	assert.equal(canonicalEjsonSha256(first), canonicalEjsonSha256(reordered));
	reordered.z = new Date("2026-08-05T00:00:00.001Z");
	assert.notEqual(canonicalEjsonSha256(first), canonicalEjsonSha256(reordered));
});

test("builds exact deterministic corrections for both reservations", () => {
	const fixtures = fixtureSet();
	const plans = buildRepairPlans({ ...fixtures, context: context() });
	assert.equal(plans.length, 2);
	for (const plan of plans) {
		const { target, expectedDocument: after } = plan;
		assert.equal(plan.originalHash.length, 64);
		assert.equal(plan.expectedHash.length, 64);
		assert.equal(plan.casFilterHash.length, 64);
		assert.ok(
			canonicalEqual(plan.casFilter.$and[0], plan.originalDocument),
		);
		assert.deepEqual(plan.casFilter.$and[1], {
			$expr: {
				$eq: [
					{ $size: { $objectToArray: "$$ROOT" } },
					Object.keys(plan.originalDocument).length,
				],
			},
		});
		assert.equal(after.confirmation_number, target.pmsConfirmation);
		assert.equal(after.reservation_id, target.otaConfirmation);
		assert.equal(after.otaIdentityKey, target.otaIdentityKey);
		assert.equal(
			after.otaCrossTransportIdentityKey,
			target.crossTransportIdentityKey,
		);
		assert.equal(after.supplierData.otaProvider, "hotelrunner");
		assert.equal(after.otaPlatformReview.provider, "hotelrunner");
		assert.equal(after.adminPricing.provider, "hotelrunner");
		assert.equal(after.booking_source, "trip.com");
		assert.equal(after.customer_details.booking_source, "Trip.com");
		assert.equal(after.supplierData.supplierName, "Trip.com");
		assert.equal(after.adminPricing.providerLabel, "Trip.com");
		assert.equal(after.otaPlatformReview.providerLabel, "Trip.com");
		assert.deepEqual(after.ota_financial_summary, {
			show: true,
			source: "ota_email_create",
			provider: "hotelrunner",
			providerLabel: "Trip.com",
			currency: "SAR",
			clientTotal: target.corrected.clientSar,
			hotelVisibleAmount: target.corrected.rootSar,
			netAfterExpenses: target.corrected.payoutSar,
			netAfterOtaExpenses: target.corrected.payoutSar,
			otaExpenseTotal: target.corrected.expenseSar,
			platformProfit: target.corrected.marginSar,
			commissionAmount: target.corrected.commissionSar,
			sourceCurrency: "USD",
			sourceAmount: target.corrected.clientUsd,
			sourceExchangeRateToSar: target.exchange.rateToSar,
			sourceExchangeRateSource: target.exchange.rateSource,
			paymentSummary: {
				sourceCurrency: "USD",
				sourceTotalGuestPaymentAmount: target.corrected.clientUsd,
				sourceTotalPayoutAmount: target.corrected.payoutUsd,
				totalGuestPaymentAmount: target.corrected.clientSar,
				totalPayoutAmount: target.corrected.payoutSar,
				currency: "SAR",
				exchangeRateToSar: target.exchange.rateToSar,
				exchangeRateSource: target.exchange.rateSource,
				amountConvertedAt: new Date(
					target.exchange.paymentAmountConvertedAt,
				),
			},
			payoutFallbackReason: "",
		});
		assert.equal(after.supplierData.otaSourceAuthority, 3);
		assert.equal(after.total_amount, target.corrected.clientSar);
		assert.equal(after.adminPricing.sourceAmount, target.corrected.clientUsd);
		assert.equal(
			after.adminPricing.sourceClientTotalSource,
			SOURCE_CLIENT_TOTAL_SOURCE,
		);
		assert.equal(after.adminPricing.defaultDeductionApplied, false);
		assert.equal(
			after.supplierData.otaPaymentSummary.sourceTotalPayoutAmount,
			target.corrected.payoutUsd,
		);
		assert.equal(
			after.supplierData.otaPaymentCollectionModel,
			"ota_collect",
		);
		assert.equal(
			after.supplierData.otaPaymentInstructions,
			PAYMENT_INSTRUCTIONS,
		);
		assert.equal(after.payment, "paid online");
		assert.equal(after.financeStatus, "paid online");
		assert.equal(after.paid_amount, target.corrected.clientSar);
		assert.equal(
			after.paid_amount_breakdown.paid_online_other_platforms,
			target.corrected.clientSar,
		);
		assert.equal(
			after.paid_amount_breakdown.payment_comments,
			PAYMENT_COMMENT,
		);
		assert.equal(after.payment_details.captured, false);
		assert.equal(
			Object.hasOwn(after.vcc_payment, "source"),
			false,
		);
		assert.equal(
			Object.hasOwn(after.vcc_payment.metadata, "card_last4"),
			false,
		);
		assert.equal(hasCaptureEvidence(after), false);
		assert.equal(after.financial_cycle.collectionModel, "pms_collected");
		assert.equal(
			after.financial_cycle.pmsCollectedAmount,
			target.corrected.clientSar,
		);
		assert.equal(
			after.financial_cycle.hotelPayoutDue,
			target.corrected.rootSar,
		);
		assert.equal(after.__v, 1);
		assert.equal(after.reservationAuditLog.length, 2);
		assert.equal(
			after.reservationAuditLog.at(-1).repairId,
			REPAIR_ID,
		);
		assert.deepEqual(
			after.reservationAuditLog.at(-1).evidenceAuditIds,
			target.audits.map((audit) => audit.id),
		);
	}

	const longStay = plans[0].expectedDocument.pickedRoomsType[0];
	assert.equal(longStay.chosenPrice, 61.19);
	assert.deepEqual(
		longStay.pricingByDay.map((day) => day.clientPrice),
		[60.23, 60.23, 60.23, 60.22, 63.11, 63.11],
	);
	assert.deepEqual(
		longStay.pricingByDay.map((day) => day.netAfterOtaExpenses),
		[56.89, 56.89, 56.89, 56.89, 59.58, 59.58],
	);
	assert.deepEqual(
		longStay.pricingByDay.map((day) => day.otaExpenseAmount),
		[3.34, 3.34, 3.34, 3.33, 3.53, 3.53],
	);
});

test("pure update simulation leaves the source fixture untouched", () => {
	const fixtures = fixtureSet();
	const original = fixtures.reservations[0];
	const originalHash = canonicalEjsonSha256(original);
	const [plan] = buildRepairPlans({ ...fixtures, context: context() });
	const reapplied = applyUpdateToDocument(original, plan.update);
	assert.equal(canonicalEjsonSha256(reapplied), plan.expectedHash);
	assert.equal(canonicalEjsonSha256(original), originalHash);
});

test("the database write helper uses the exact shape-aware CAS, majority write concern, and deterministic post-read", async () => {
	const fixtures = fixtureSet();
	const [plan] = buildRepairPlans({ ...fixtures, context: context() });
	let stored = cloneBson(plan.originalDocument);
	let updateCalls = 0;
	const collection = {
		async updateOne(filter, update, options) {
			updateCalls += 1;
			assert.ok(canonicalEqual(filter, plan.casFilter));
			assert.ok(canonicalEqual(update, plan.update));
			assert.deepEqual(options, { writeConcern: { w: "majority" } });
			stored = applyUpdateToDocument(stored, update);
			return { matchedCount: 1, modifiedCount: 1 };
		},
		async findOne(filter, options) {
			assert.deepEqual(filter, { _id: new ObjectId(plan.target.mongoId) });
			assert.deepEqual(options, {
				readPreference: "primary",
				readConcern: { level: "majority" },
			});
			return cloneBson(stored);
		},
	};
	const saved = await updateOnePlan({
		plan,
		reservationCollection: collection,
	});
	assert.equal(updateCalls, 1);
	assert.equal(canonicalEjsonSha256(saved), plan.expectedHash);

	await assert.rejects(
		updateOnePlan({
			plan,
			reservationCollection: {
				updateOne: async () => ({ matchedCount: 0, modifiedCount: 0 }),
				findOne: async () => {
					throw new Error("post-read must not run after a failed CAS");
				},
			},
		}),
		/CAS filter did not match/,
	);
});

const nonTransactionalApplyHarness = ({
	secondWriteMode = "success",
	pauseBeforeSecondFence = false,
} = {}) => {
	const fixtures = fixtureSet();
	const manifest = {
		_id: REPAIR_ID,
		operation: OPERATION,
		state: "backed_up",
		backupCollection: BACKUP_COLLECTION,
		repairAt: REPAIR_AT,
		backupAt: REPAIR_AT,
	};
	const plans = buildRepairPlans({ ...fixtures, context: context() });
	const backupRecords = buildBackupRecords({
		plans,
		audits: fixtures.audits,
		repairId: REPAIR_ID,
		backupCollection: BACKUP_COLLECTION,
		backupAt: REPAIR_AT,
	});
	const documents = new Map(
		fixtures.reservations.map((reservation) => [
			String(reservation._id),
			cloneBson(reservation),
		]),
	);
	let reservationWriteNumber = 0;
	let manifestFenceReadNumber = 0;
	let releaseSecondFence;
	let markSecondFenceReached;
	const secondFenceReached = new Promise((resolve) => {
		markSecondFenceReached = resolve;
	});
	const secondFenceRelease = new Promise((resolve) => {
		releaseSecondFence = resolve;
	});
	const assertMajority = (options) =>
		assert.deepEqual(options, { writeConcern: { w: "majority" } });
	const assertPrimaryMajority = (options) =>
		assert.deepEqual(options, {
			readPreference: "primary",
			readConcern: { level: "majority" },
		});
	const exactFilterMatches = (filter, current) =>
		canonicalEqual(filter?.$and?.[0], current) &&
		Number(filter?.$and?.[1]?.$expr?.$eq?.[1]) ===
			Object.keys(current || {}).length;
	const reservationCollection = {
		find(_filter, options) {
			assertPrimaryMajority(options);
			return {
				toArray: async () => cloneBson([...documents.values()]),
			};
		},
		async findOne(filter, options) {
			assertPrimaryMajority(options);
			return cloneBson(documents.get(String(filter._id)) || null);
		},
		async updateOne(filter, update, options) {
			assertMajority(options);
			reservationWriteNumber += 1;
			const mongoId = String(filter.$and[0]._id);
			const current = documents.get(mongoId);
			if (!exactFilterMatches(filter, current)) {
				return { matchedCount: 0, modifiedCount: 0 };
			}
			if (
				reservationWriteNumber === 2 &&
				secondWriteMode === "clean_rejection"
			) {
				return { matchedCount: 0, modifiedCount: 0 };
			}
			documents.set(mongoId, applyUpdateToDocument(current, update));
			if (
				reservationWriteNumber === 2 &&
				secondWriteMode === "committed_ack_lost"
			) {
				throw new Error("simulated network loss after commit");
			}
			return { matchedCount: 1, modifiedCount: 1 };
		},
		async replaceOne(filter, replacement, options) {
			assertMajority(options);
			const mongoId = String(replacement._id);
			const current = documents.get(mongoId);
			if (!exactFilterMatches(filter, current)) {
				return { matchedCount: 0, modifiedCount: 0 };
			}
			documents.set(mongoId, cloneBson(replacement));
			return { matchedCount: 1, modifiedCount: 1 };
		},
	};
	const inboundCollection = {
		find(_filter, options) {
			assertPrimaryMajority(options);
			return {
				toArray: async () => cloneBson(fixtures.audits),
			};
		},
	};
	const savedManifest = cloneBson(manifest);
	const manifestMatches = (filter) =>
		String(filter._id) === REPAIR_ID &&
		(typeof filter.state === "string"
			? savedManifest.state === filter.state
			: filter.state?.$in?.includes(savedManifest.state)) &&
		(!filter.applyOperationToken ||
			savedManifest.applyOperationToken === filter.applyOperationToken) &&
		(!filter.rollbackOperationToken ||
			savedManifest.rollbackOperationToken === filter.rollbackOperationToken);
	const manifestCollection = {
		async findOne(filter, options) {
			assert.deepEqual(options, {
				readPreference: "primary",
				readConcern: { level: "majority" },
				projection: { _id: 1 },
			});
			manifestFenceReadNumber += 1;
			if (pauseBeforeSecondFence && manifestFenceReadNumber === 2) {
				markSecondFenceReached();
				await secondFenceRelease;
			}
			return manifestMatches(filter) ? { _id: REPAIR_ID } : null;
		},
		async updateOne(filter, update, options) {
			assertMajority(options);
			if (!manifestMatches(filter)) {
				return { matchedCount: 0, modifiedCount: 0 };
			}
			Object.assign(savedManifest, cloneBson(update.$set || {}));
			return { matchedCount: 1, modifiedCount: 1 };
		},
	};
	const db = {
		collection(name) {
			assert.equal(name, "ota_trip_source_repair_manifests");
			return manifestCollection;
		},
	};
	return {
		backupRecords,
		db,
		documents,
		fixtures,
		getReservationWriteNumber: () => reservationWriteNumber,
		inboundCollection,
		manifest,
		plans,
		reservationCollection,
		releaseSecondFence,
		savedManifest,
		secondFenceReached,
	};
};

test("standalone production path applies both serial CAS writes and postverifies before finalizing", async () => {
	const harness = nonTransactionalApplyHarness();
	const plans = await applyWithoutTransaction(harness);
	assert.equal(harness.savedManifest.state, "applied");
	for (const plan of plans) {
		assert.equal(
			canonicalEjsonSha256(
				harness.documents.get(plan.target.mongoId),
			),
			plan.expectedHash,
		);
	}
});

test("standalone production path restores both originals after a clean rejection or lost write acknowledgement", async () => {
	for (const secondWriteMode of [
		"clean_rejection",
		"committed_ack_lost",
	]) {
		const harness = nonTransactionalApplyHarness({ secondWriteMode });
		await assert.rejects(
			applyWithoutTransaction(harness),
			/every changed reservation was conditionally restored/,
		);
		assert.equal(harness.savedManifest.state, "apply_failed_rolled_back");
		for (const plan of harness.plans) {
			assert.equal(
				canonicalEjsonSha256(
					harness.documents.get(plan.target.mongoId),
				),
				plan.originalHash,
			);
		}
	}
});

test("a paused standalone apply cannot resume writes after manifest ownership changes", async () => {
	const harness = nonTransactionalApplyHarness({
		pauseBeforeSecondFence: true,
	});
	const runningApply = applyWithoutTransaction(harness);
	await harness.secondFenceReached;
	assert.equal(harness.getReservationWriteNumber(), 1);

	// Simulate an external/manual recovery that restored the first record and
	// finalized the manifest while the old writer was paused. The old operation
	// token must prevent the second reservation write when it resumes.
	const firstPlan = harness.plans[0];
	harness.documents.set(
		firstPlan.target.mongoId,
		cloneBson(firstPlan.originalDocument),
	);
	harness.savedManifest.state = "rolled_back";
	harness.savedManifest.rollbackOperationToken = "new-owner";
	harness.releaseSecondFence();

	await assert.rejects(runningApply, /ownership fence|recording the compensated/);
	assert.equal(harness.getReservationWriteNumber(), 1);
	for (const plan of harness.plans) {
		assert.equal(
			canonicalEjsonSha256(
				harness.documents.get(plan.target.mongoId),
			),
			plan.originalHash,
		);
	}
	assert.equal(harness.savedManifest.state, "rolled_back");
});

test("preflight rejects identity, source, pricing, VCC, capture, room, version, and audit drift", () => {
	const mutators = [
		(reservations) => {
			reservations[0].confirmation_number = EXCLUDED_PMS_CONFIRMATION;
		},
		(reservations) => {
			reservations[0].otaIdentityKey = "trip:1651516732730092";
		},
		(reservations) => {
			reservations[0].otaCrossTransportIdentityKey =
				"trip:1651516732730092";
		},
		(reservations) => {
			reservations[0].ota_financial_summary = { clientTotal: 1 };
		},
		(reservations) => {
			reservations[0].supplierData.otaProvider = "trip";
		},
		(reservations) => {
			reservations[0].total_amount += 0.01;
		},
		(reservations) => {
			reservations[0].adminPricing.clientTotalOverrideActive = true;
		},
		(reservations) => {
			reservations[0].vcc_payment.metadata.card_last4 = "1111";
		},
		(reservations) => {
			reservations[0].payment_details.captured = true;
		},
		(reservations) => {
			reservations[0].paid_amount_breakdown.paid_at_hotel_cash = -1;
		},
		(reservations) => {
			reservations[0].moneyTransferredToHotel = true;
		},
		(reservations) => {
			reservations[0].commissionPaid = true;
		},
		(reservations) => {
			reservations[0].moneyTransferredAt = new Date();
		},
		(reservations) => {
			reservations[0].commissionPaidAt = new Date();
		},
		(reservations) => {
			reservations[0].commissionData = { paid: true };
		},
		(reservations) => {
			reservations[0].commissionStatus = "paid";
		},
		(reservations) => {
			reservations[0].adminChangeLog.push({ field: "commissionPaid" });
		},
		(reservations) => {
			reservations[0].payment_details.external_transaction_id = "captured-1";
		},
		(reservations) => {
			reservations[0].vcc_payment.last_capture = { id: "capture-1" };
		},
		(reservations) => {
			reservations[0].braintree_payment = {
				last_transaction_id: "braintree-1",
			};
		},
		(reservations) => {
			reservations[0].bofa_payment.vcc.attempts_count = 1;
		},
		(reservations) => {
			reservations[0].bofa_payment.secure_acceptance.last_transaction_uuid =
				"bofa-1";
		},
		(reservations) => {
			reservations[0].paypal_details = { transaction_id: "paypal-1" };
		},
		(reservations) => {
			reservations[0].pickedRoomsPricing[0].room_type = "tripleRooms";
		},
		(reservations) => {
			reservations[0].pickedRoomsType[0].pricingByDay[0].date = "2026-08-25";
		},
		(reservations) => {
			reservations[0].pickedRoomsType[0].pricingByDay[0].otaExpenseRate = 0.2;
			reservations[0].pickedRoomsPricing[0].pricingByDay[0].otaExpenseRate = 0.2;
		},
		(reservations) => {
			reservations[0].__v = 1;
		},
		(reservations) => {
			reservations[0].updatedAt = new Date("2026-08-05T01:00:00.000Z");
		},
	];
	for (const mutate of mutators) {
		const fixtures = fixtureSet();
		mutate(fixtures.reservations);
		assert.throws(() =>
			buildRepairPlans({ ...fixtures, context: context() }),
		);
	}

	const missingAudit = fixtureSet();
	missingAudit.audits.pop();
	assert.throws(() => validateAuditSet(missingAudit.audits), /Exactly 6/);

	const wrongAudit = fixtureSet();
	wrongAudit.audits[0].confirmationNumber = "9999999999999999";
	assert.throws(
		() => buildRepairPlans({ ...wrongAudit, context: context() }),
		/confirmationNumber/,
	);
});

test("capture detection is fail-closed for every processor while empty defaults remain safe", () => {
	const safe = reservationFixture(TARGETS[0]);
	safe.vcc_payment.last_capture = {};
	safe.braintree_payment = {
		source: "",
		charged: false,
		processing: false,
		attempts_count: 0,
		last_attempt_at: null,
		attempts: [],
	};
	safe.bofa_payment.secure_acceptance.currency = "USD";
	safe.bofa_payment.secure_acceptance.transaction_type = "sale";
	safe.paypal_details = {};
	assert.equal(hasCaptureEvidence(safe), false);

	for (const mutate of [
		(reservation) => {
			reservation.payment_details.processor_reference = "processor-1";
		},
		(reservation) => {
			reservation.vcc_payment.last_capture = { transactionId: "vcc-1" };
		},
		(reservation) => {
			reservation.braintree_payment.last_transaction_id = "bt-1";
		},
		(reservation) => {
			reservation.bofa_payment.vcc.outcome_unknown = true;
		},
		(reservation) => {
			reservation.bofa_payment.secure_acceptance.last_request_id = "bofa-1";
		},
		(reservation) => {
			reservation.paypal_details.capture_id = "paypal-1";
		},
	]) {
		const candidate = cloneBson(safe);
		mutate(candidate);
		assert.equal(hasCaptureEvidence(candidate), true);
	}
});

test("backup contains two full reservations and six full audits with verified hashes", () => {
	const fixtures = fixtureSet();
	const plans = buildRepairPlans({ ...fixtures, context: context() });
	const records = buildBackupRecords({
		plans,
		audits: fixtures.audits,
		repairId: REPAIR_ID,
		backupCollection: BACKUP_COLLECTION,
		backupAt: REPAIR_AT,
	});
	assert.equal(records.length, 8);
	assert.equal(
		records.filter((record) => record.sourceCollection === "reservations")
			.length,
		2,
	);
	assert.equal(
		records.filter((record) => record.sourceCollection === "inboundemails")
			.length,
		6,
	);
	assert.equal(
		verifyBackupRecords({
			records,
			repairId: REPAIR_ID,
			backupCollection: BACKUP_COLLECTION,
		}),
		true,
	);
	comparePlannedAndSavedBackups(records, cloneBson(records));

	const tampered = cloneBson(records);
	tampered[0].originalDocument.total_amount += 0.01;
	assert.throws(
		() =>
			verifyBackupRecords({
				records: tampered,
				repairId: REPAIR_ID,
				backupCollection: BACKUP_COLLECTION,
			}),
		/canonical EJSON SHA-256/,
	);
});

test("CLI is dry-run by default and every write mode requires an explicit repair ID", () => {
	assert.deepEqual(parseCliArguments([]), {
		apply: false,
		rollback: false,
		repairId: "",
		help: false,
	});
	assert.throws(
		() => parseCliArguments(["--apply"]),
		/--apply requires/,
	);
	assert.throws(
		() => parseCliArguments(["--rollback"]),
		/--rollback requires/,
	);
	assert.deepEqual(
		parseCliArguments([
			"--rollback",
			"--apply",
			"--repair-id",
			REPAIR_ID,
		]),
		{
			apply: true,
			rollback: true,
			repairId: REPAIR_ID,
			help: false,
		},
	);
	assert.throws(
		() => parseCliArguments(["--apply", "--repair-id", "bad id"]),
		/8-80 characters/,
	);
	assert.throws(() => parseCliArguments(["--all"]), /Unknown argument/);
});

test("help returns before any database connection is attempted", async () => {
	const result = await main(["--help"]);
	assert.match(result.help, /Dry-run is the default/);
	assert.match(result.help, /7043857218 is excluded/);
});

test("transaction support requires sessions plus replica-set or mongos topology", () => {
	assert.equal(
		transactionSupportFromHello({
			logicalSessionTimeoutMinutes: 30,
			maxWireVersion: 17,
			setName: "atlas-replica",
		}),
		true,
	);
	assert.equal(
		transactionSupportFromHello({
			logicalSessionTimeoutMinutes: 30,
			maxWireVersion: 8,
			msg: "isdbgrid",
		}),
		true,
	);
	assert.equal(
		transactionSupportFromHello({
			logicalSessionTimeoutMinutes: 30,
			maxWireVersion: 7,
			msg: "isdbgrid",
		}),
		false,
	);
	assert.equal(
		transactionSupportFromHello({
			logicalSessionTimeoutMinutes: 30,
			maxWireVersion: 17,
		}),
		false,
	);
});

test("rollback classification allows only exact original or exact repaired documents", () => {
	const fixtures = fixtureSet();
	const plans = buildRepairPlans({ ...fixtures, context: context() });
	const original = classifyRollbackState({
		scope: { reservations: fixtures.reservations },
		plans,
	});
	assert.deepEqual(
		original.map((entry) => entry.state),
		["original", "original"],
	);
	const repaired = classifyRollbackState({
		scope: {
			reservations: plans.map((plan) => cloneBson(plan.expectedDocument)),
		},
		plans,
	});
	assert.deepEqual(
		repaired.map((entry) => entry.state),
		["repaired", "repaired"],
	);
	const changed = plans.map((plan) => cloneBson(plan.expectedDocument));
	changed[0].financeStatus = "manually changed";
	assert.equal(
		classifyRollbackState({
			scope: { reservations: changed },
			plans,
		})[0].state,
		"changed_or_unknown",
	);
});

test("rollback permanently refuses active or stale operation takeover", () => {
	for (const manifest of [
		{
			_id: REPAIR_ID,
			state: "applying",
			applyStartedAt: new Date("2026-08-05T06:59:00.000Z"),
		},
		{
			_id: REPAIR_ID,
			state: "applying",
			applyStartedAt: new Date("2020-01-01T00:00:00.000Z"),
		},
		{
			_id: REPAIR_ID,
			state: "rolling_back",
			rollbackStartedAt: new Date("2026-08-05T06:59:00.000Z"),
		},
		{
			_id: REPAIR_ID,
			state: "rolling_back",
			rollbackStartedAt: new Date("2020-01-01T00:00:00.000Z"),
		},
	]) {
		assert.throws(
			() => rollbackClaimStates(manifest),
			/Automatic takeover is permanently disabled/,
		);
	}
	const stableManifest = { _id: REPAIR_ID, state: "applied" };
	const stableStates = rollbackClaimStates(stableManifest);
	assert.equal(stableStates.includes("applying"), false);
	assert.equal(stableStates.includes("rolling_back"), false);
	assert.deepEqual(
		rollbackManifestClaimFilter(stableManifest, stableStates),
		{
			_id: REPAIR_ID,
			state: { $in: stableStates },
		},
	);
});

test("dry-run report is redacted, fixed-scope, and explicitly reports zero writes", () => {
	const fixtures = fixtureSet();
	const plans = buildRepairPlans({ ...fixtures, context: context() });
	const report = buildDryRunReport({
		plans,
		audits: fixtures.audits,
		repairId: REPAIR_ID,
	});
	assert.equal(report.mode, "dry-run");
	assert.equal(report.writesPerformed, false);
	assert.equal(report.sourceDocumentsRead, 8);
	assert.deepEqual(report.scope.pmsConfirmations, [
		"8234871006",
		"9764914393",
	]);
	assert.equal(report.scope.excludedPmsConfirmation, "7043857218");
	assert.equal(report.safety.emailReplay, false);
	const serialized = JSON.stringify(report);
	assert.equal(serialized.includes("Offline fixture guest"), false);
	assert.equal(serialized.includes("bodyText"), false);
	assert.equal(serialized.includes("Stored historical source"), false);
});

test("manifest validation locks operation, all eight source IDs, and exclusion", () => {
	const manifest = {
		_id: REPAIR_ID,
		operation: OPERATION,
		state: "backed_up",
		backupCollection: BACKUP_COLLECTION,
		repairAt: REPAIR_AT,
		backupAt: REPAIR_AT,
		scope: {
			pmsConfirmations: TARGETS.map((target) => target.pmsConfirmation),
			reservationMongoIds: TARGETS.map((target) => target.mongoId),
			inboundAuditIds: ALL_AUDIT_IDS,
			excludedPmsConfirmation: EXCLUDED_PMS_CONFIRMATION,
		},
	};
	assert.equal(validateManifest(manifest, REPAIR_ID), manifest);
	const broadened = cloneBson(manifest);
	broadened.scope.pmsConfirmations.push(EXCLUDED_PMS_CONFIRMATION);
	assert.throws(
		() => validateManifest(broadened, REPAIR_ID),
		/PMS scope changed/,
	);
	const redirectedBackup = cloneBson(manifest);
	redirectedBackup.backupCollection = `${BACKUP_COLLECTION}_foreign`;
	assert.throws(
		() => validateManifest(redirectedBackup, REPAIR_ID),
		/invalid backup collection/,
	);
});

test("transactional scope reads are serial and retain the identical session", async () => {
	const fixtures = fixtureSet();
	const sequence = [];
	let active = 0;
	let maximumActive = 0;
	const session = { transaction: "unit-test" };
	const fakeCollection = (label, rows) => ({
		find(_filter, options) {
			assert.equal(options.session, session);
			return {
				async toArray() {
					sequence.push(`${label}:start`);
					active += 1;
					maximumActive = Math.max(maximumActive, active);
					await new Promise((resolve) => setImmediate(resolve));
					active -= 1;
					sequence.push(`${label}:end`);
					return cloneBson(rows);
				},
			};
		},
	});
	const loaded = await loadScope({
		session,
		reservationCollection: fakeCollection(
			"reservations",
			fixtures.reservations,
		),
		inboundCollection: fakeCollection("audits", fixtures.audits),
	});
	assert.equal(loaded.reservations.length, 2);
	assert.equal(loaded.audits.length, 6);
	assert.equal(maximumActive, 1);
	assert.deepEqual(sequence, [
		"reservations:start",
		"reservations:end",
		"audits:start",
		"audits:end",
	]);
});

const fakeBridgeCollection = ({
	indexes = [{ name: "_id_", key: { _id: 1 } }],
	duplicates = [],
	claims = [],
} = {}) => {
	const state = {
		indexes: cloneBson(indexes),
		duplicates: cloneBson(duplicates),
		claims: cloneBson(claims),
		createCalls: [],
	};
	return {
		state,
		listIndexes: () => ({
			toArray: async () => cloneBson(state.indexes),
		}),
		aggregate: () => ({
			toArray: async () => cloneBson(state.duplicates),
		}),
		find: () => ({
			toArray: async () => cloneBson(state.claims),
		}),
		async createIndex(key, options) {
			state.createCalls.push({ key: cloneBson(key), options: cloneBson(options) });
			state.indexes.push({
				name: options.name,
				key: cloneBson(key),
				unique: options.unique,
				partialFilterExpression: cloneBson(
					options.partialFilterExpression,
				),
			});
			return options.name;
		},
	};
};

test("bridge-index dry run detects absence without writing and apply creates the exact partial unique index", async () => {
	const collection = fakeBridgeCollection();
	const dryRun = await inspectCrossTransportIndex({
		reservationCollection: collection,
	});
	assert.equal(dryRun.present, false);
	assert.equal(dryRun.wouldCreate, true);
	assert.equal(collection.state.createCalls.length, 0);

	const applied = await ensureCrossTransportIndex({
		reservationCollection: collection,
	});
	assert.equal(applied.present, true);
	assert.equal(applied.created, true);
	assert.equal(collection.state.createCalls.length, 1);
	assert.deepEqual(collection.state.createCalls[0], {
		key: CROSS_TRANSPORT_INDEX_KEY,
		options: {
			name: CROSS_TRANSPORT_INDEX_NAME,
			unique: true,
			partialFilterExpression: CROSS_TRANSPORT_INDEX_PARTIAL,
			writeConcern: { w: "majority" },
		},
	});
});

test("bridge-index checks reject duplicates, conflicting definitions, and foreign target claims", async () => {
	await assert.rejects(
		inspectCrossTransportIndex({
			reservationCollection: fakeBridgeCollection({
				duplicates: [{ _id: "trip:duplicate", count: 2 }],
			}),
		}),
		/Duplicate non-empty/,
	);
	await assert.rejects(
		inspectCrossTransportIndex({
			reservationCollection: fakeBridgeCollection({
				indexes: [
					{ name: "_id_", key: { _id: 1 } },
					{
						name: CROSS_TRANSPORT_INDEX_NAME,
						key: CROSS_TRANSPORT_INDEX_KEY,
						unique: false,
						partialFilterExpression: CROSS_TRANSPORT_INDEX_PARTIAL,
					},
				],
			}),
		}),
		/must be unique/,
	);
	await assert.rejects(
		inspectCrossTransportIndex({
			reservationCollection: fakeBridgeCollection({
				claims: [
					{
						_id: new ObjectId("6a6f890349ca9d9ba5287269"),
						confirmation_number: EXCLUDED_PMS_CONFIRMATION,
						otaCrossTransportIdentityKey:
							TARGETS[0].crossTransportIdentityKey,
					},
				],
			}),
		}),
		/already claimed/,
	);
});

test("bridge-index postverify locks both bridge keys to the intended reservation owners", async () => {
	const collection = fakeBridgeCollection({
		indexes: [
			{ name: "_id_", key: { _id: 1 } },
			{
				name: CROSS_TRANSPORT_INDEX_NAME,
				key: CROSS_TRANSPORT_INDEX_KEY,
				unique: true,
				partialFilterExpression: CROSS_TRANSPORT_INDEX_PARTIAL,
			},
		],
		claims: TARGETS.map((target) => ({
			_id: new ObjectId(target.mongoId),
			confirmation_number: target.pmsConfirmation,
			otaCrossTransportIdentityKey: target.crossTransportIdentityKey,
		})),
	});
	const result = await inspectCrossTransportIndex({
		reservationCollection: collection,
		targetClaimState: "repaired",
	});
	assert.equal(result.targetClaimsVerified, 2);
});
