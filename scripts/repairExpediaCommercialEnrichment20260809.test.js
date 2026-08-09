/** @format */

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { ObjectId } = require("bson");

const {
	BACKUP_COLLECTION,
	COLLECTIONS,
	DEFAULT_PORTAL_SELECTION,
	MANIFEST_COLLECTION,
	REPAIR_ID,
	TARGET,
	applyRepairPlan,
	applyRollbackPlan,
	assertWritablePrimary,
	buildCommercialEvidence,
	buildExpectedDocument,
	commercialProtectedSnapshot,
	loadPlan,
	loadRollbackPlan,
	parseArguments,
	parseProof,
	portalSelectionFromArguments,
	repairProofToken,
	rollbackProofToken,
	verifyBackupRecords,
} = require("./repairExpediaCommercialEnrichment20260809");
const {
	canonicalEjsonSha256,
	cloneBson,
} = require("../services/recentOtaInboundRecovery20260805");

const RELEASE_SHA = "a".repeat(40);
const PLANNED_AT = new Date("2026-08-09T04:15:00.000Z");
const ROLLBACK_AT = new Date("2026-08-09T04:25:00.000Z");
const OWNER_ID = new ObjectId("68b74714fb50e159d48c714d");
const CUSTOM_PORTAL_SELECTION = Object.freeze({
	jobId: "6a77f999cdbc8acbbe4968a6",
	jobNumber: "OTA-RES-SYNC-20260809050000-ABCDE",
});

const oid = (value) => new ObjectId(value);
const getPath = (document, pathText) =>
	String(pathText)
		.split(".")
		.reduce((current, key) => (current == null ? undefined : current[key]), document);

function setPath(document, pathText, value) {
	const parts = String(pathText).split(".");
	let current = document;
	for (const part of parts.slice(0, -1)) {
		if (!current[part] || typeof current[part] !== "object") current[part] = {};
		current = current[part];
	}
	current[parts.at(-1)] = cloneBson(value);
}

function equal(left, right) {
	return canonicalEjsonSha256(left) === canonicalEjsonSha256(right);
}

function matches(document, filter = {}) {
	for (const [pathText, expected] of Object.entries(filter || {})) {
		if (pathText === "$and") {
			if (!expected.every((branch) => matches(document, branch))) return false;
			continue;
		}
		if (pathText === "$or") {
			if (!expected.some((branch) => matches(document, branch))) return false;
			continue;
		}
		if (pathText === "$expr") {
			const expectedKeys = expected?.$eq?.[1];
			if (Object.keys(document || {}).length !== expectedKeys) return false;
			continue;
		}
		const actual = getPath(document, pathText);
		if (
			expected &&
			typeof expected === "object" &&
			!Array.isArray(expected) &&
			Object.prototype.hasOwnProperty.call(expected, "$in")
		) {
			if (!expected.$in.some((value) => equal(actual, value))) return false;
			continue;
		}
		if (!equal(actual, expected)) return false;
	}
	return true;
}

class MemoryCollection {
	constructor(documents = []) {
		this.documents = documents.map(cloneBson);
		this.replaceCalls = 0;
	}

	find(filter) {
		const collection = this;
		return {
			max: Infinity,
			limit(value) {
				this.max = value;
				return this;
			},
			async toArray() {
				return collection.documents
					.filter((document) => matches(document, filter))
					.slice(0, this.max)
					.map(cloneBson);
			},
		};
	}

	async findOne(filter) {
		const found = this.documents.find((document) => matches(document, filter));
		return found ? cloneBson(found) : null;
	}

	async insertOne(document) {
		if (this.documents.some((candidate) => equal(candidate._id, document._id))) {
			throw new Error("duplicate key");
		}
		this.documents.push(cloneBson(document));
		return { acknowledged: true, insertedId: document._id };
	}

	async replaceOne(filter, replacement) {
		this.replaceCalls += 1;
		const index = this.documents.findIndex((document) => matches(document, filter));
		if (index < 0) {
			return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
		}
		this.documents[index] = cloneBson(replacement);
		return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
	}

	async updateOne(filter, update) {
		const document = this.documents.find((candidate) => matches(candidate, filter));
		if (!document) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
		for (const [pathText, value] of Object.entries(update.$set || {})) {
			setPath(document, pathText, value);
		}
		return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
	}
}

class MemoryDb {
	constructor(seed = {}) {
		this.collections = new Map(
			Object.entries(seed).map(([name, documents]) => [
				name,
				new MemoryCollection(documents),
			])
		);
	}

	collection(name) {
		if (!this.collections.has(name)) {
			this.collections.set(name, new MemoryCollection());
		}
		return this.collections.get(name);
	}
}

function nightlyRows() {
	return TARGET.dailyRoot.map((rootPrice, index) => {
		const date = new Date(`${TARGET.checkinDate}T00:00:00.000Z`);
		date.setUTCDate(date.getUTCDate() + index);
		const falseAmount = TARGET.dailyFalseCanonical[index];
		return {
			date: date.toISOString().slice(0, 10),
			price: falseAmount,
			clientPrice: falseAmount,
			mainPrice: falseAmount,
			rootPrice,
			commissionRate: 0,
			totalPriceWithCommission: falseAmount,
			totalPriceWithoutCommission: rootPrice,
			netAfterExpenses: falseAmount,
			netAfterOtaExpenses: falseAmount,
			otaExpenseAmount: 0,
			platformMargin: Number((falseAmount - rootPrice).toFixed(2)),
			commercialVerification: "unsafe_legacy_projection",
		};
	});
}

function fixture({ payout = null, portalSelection = DEFAULT_PORTAL_SELECTION } = {}) {
	const pricingByDay = nightlyRows();
	const room = {
		room_type: "doubleRooms",
		displayName: "Protected mapped room",
		hotelRoomConfigId: oid("6a40df5f1a6d1850eb25c183"),
		localRoomConfigId: oid("6a40df5f1a6d1850eb25c183"),
		hotelRunnerRoomId: "hr-room-1",
		count: 1,
		chosenPrice: 70.58,
		totalPriceWithCommission: TARGET.oldCanonicalClientTotal,
		hotelShouldGet: TARGET.rootTotal,
		pricingByDay,
	};
	const reservation = {
		_id: oid(TARGET.reservationMongoId),
		__v: TARGET.reservationVersion,
		createdAt: new Date("2026-08-09T02:15:00.000Z"),
		updatedAt: new Date("2026-08-09T02:16:00.000Z"),
		hotelId: oid(TARGET.hotelId),
		belongsTo: OWNER_ID,
		confirmation_number: TARGET.pmsConfirmationNumber,
		reservation_id: TARGET.otaBookingId,
		hr_number: TARGET.hrNumber.toLowerCase(),
		otaIdentityKey: TARGET.otaIdentityKey,
		otaCrossTransportIdentityKey: "",
		booking_source: "expedia",
		customer_details: {
			name: "PRIVATE TEST GUEST",
			confirmation_number2: TARGET.otaBookingId,
		},
		state: "confirmed",
		reservation_status: "confirmed",
		checkin_date: new Date(`${TARGET.checkinDate}T00:00:00.000Z`),
		checkout_date: new Date(`${TARGET.checkoutDate}T00:00:00.000Z`),
		days_of_residence: TARGET.nights,
		total_rooms: 1,
		total_guests: 2,
		adults: 2,
		children: 0,
		roomId: [],
		bedNumber: [],
		total_amount: TARGET.oldCanonicalClientTotal,
		sub_total: TARGET.rootTotal,
		currency: "sar",
		commission: 0,
		commission_ota: null,
		financeStatus: "not paid",
		payment: "bank transfer",
		paid_amount: 0,
		payment_details: { captured: false, onsite_paid_amount: 0 },
		bofa_payment: { vcc: { charged: false, secretSentinel: "must-survive" } },
		moneyTransferredToHotel: false,
		commissionPaid: false,
		pickedRoomsType: [cloneBson(room)],
		pickedRoomsPricing: [cloneBson(room)],
		adminPricing: {
			mode: "hotelrunner_api",
			clientTotal: TARGET.oldCanonicalClientTotal,
			rootTotal: TARGET.rootTotal,
			netAfterExpensesTotal: TARGET.oldCanonicalClientTotal,
			otaExpenseTotal: 0,
			platformMarginTotal: -110.55,
			commissionAmount: 0,
			commercialVerified: false,
			defaultDeductionRate: 0.1,
			defaultDeductionApplied: false,
			source: "ota_email_create",
			sourceCurrency: "USD",
			sourceAmount: TARGET.hotelRunnerReportedAmount,
			sourceExchangeRateToSar: 3.75,
			sourceExchangeRateSource: "fallback_default",
			exchangeRateToSar: 3.75,
			exchangeRateSource: "fallback_default",
			amountConvertedAt: new Date("2026-08-09T02:15:30.000Z"),
		},
		ota_financial_summary: {
			show: true,
			source: "ota_email_create",
			currency: "SAR",
			clientTotal: TARGET.oldCanonicalClientTotal,
			hotelVisibleAmount: TARGET.rootTotal,
			netAfterExpenses: TARGET.oldCanonicalClientTotal,
			netAfterOtaExpenses: TARGET.oldCanonicalClientTotal,
			otaExpenseTotal: 0,
			platformProfit: -110.55,
			commissionAmount: 0,
			otaCommissionAmount: null,
			commercialVerified: false,
			sourceExchangeRateToSar: 3.75,
			sourceExchangeRateSource: "fallback_default",
		},
		supplierData: {
			supplierName: "Expedia",
			suppliedBookingNo: TARGET.otaBookingId,
			otaConfirmationNumber: TARGET.otaBookingId,
			platformConfirmationNumber: TARGET.otaBookingId,
			otaProvider: "expedia",
			otaAmount: TARGET.hotelRunnerReportedAmount,
			otaAmountSar: TARGET.oldCanonicalClientTotal,
			otaAmountConvertedAt: new Date("2026-08-09T02:15:30.000Z"),
			otaCurrency: "USD",
			otaExchangeRateToSar: 3.75,
			otaExchangeRateSource: "exchange_rate_api_cached",
			otaSourceAmount: TARGET.hotelRunnerReportedAmount,
			otaSourceCurrency: "USD",
			otaSourceExchangeRateToSar: 3.75,
			otaSourceExchangeRateSource: "fallback_default",
			otaTotalPayoutSar: TARGET.oldCanonicalClientTotal,
			otaExpenseTotalSar: 0,
			otaPlatformMarginSar: -110.55,
			otaCommissionSar: null,
			otaDeductionComponents: [],
			otaPaymentCollectionModel: "ota_collect",
			otaPaymentSummary: {
				sourceCurrency: "USD",
				sourceTotalGuestPaymentAmount: TARGET.hotelRunnerReportedAmount,
				totalGuestPaymentAmount: TARGET.oldCanonicalClientTotal,
				exchangeRateSource: "fallback_default",
			},
			hotelRunner: {
				transport: "hotelrunner_api",
				reservationId: TARGET.hotelRunnerReservationId,
				hrNumber: TARGET.hrNumber,
				providerNumber: TARGET.otaBookingId,
				channel: "expedia",
				immutableRawSentinel: { untouched: true },
				pricing: {
					source: "hotelrunner_api",
					currency: "USD",
					grandTotal: TARGET.hotelRunnerReportedAmount,
					hotelNetPayout: null,
					otaCommission: null,
					rooms: [
						{
							currency: "USD",
							totalAfterTax: TARGET.hotelRunnerReportedAmount,
							nightly: TARGET.dailyHotelRunnerSource.map((finalPrice, index) => {
								const date = new Date(`${TARGET.checkinDate}T00:00:00.000Z`);
								date.setUTCDate(date.getUTCDate() + index);
								return { date: date.toISOString().slice(0, 10), finalPrice };
							}),
						},
					],
				},
			},
		},
		reservationAuditLog: [{ at: new Date("2026-08-09T02:16:00.000Z"), action: "created" }],
	};
	const event = {
		_id: oid(TARGET.eventId),
		__v: 0,
		hotelId: oid(TARGET.hotelId),
		eventKey: "push:exact-expedia-event",
		messageUid: "uid-exact-expedia-event",
		payloadHash: TARGET.eventPayloadHash,
		canonicalHash: TARGET.eventCanonicalHash,
		source: "push",
		hotelRunnerReservationId: TARGET.hotelRunnerReservationId,
		hrNumber: TARGET.hrNumber,
		providerNumber: TARGET.otaBookingId,
		channel: "expedia",
		state: "reserved",
		sourceUpdatedAt: new Date("2026-08-09T02:14:00.000Z"),
		payload: {
			reservation: {
				id: TARGET.hotelRunnerReservationId,
				provider_number: TARGET.otaBookingId,
				total: TARGET.hotelRunnerReportedAmount,
				currency: "USD",
			},
		},
		status: TARGET.eventStatus,
		integrityConflict: false,
		integrityReason: "",
		reservationMongoId: oid(TARGET.reservationMongoId),
		mirrorId: oid(TARGET.mirrorId),
		receivedAt: new Date("2026-08-09T02:14:01.000Z"),
	};
	const mirror = {
		_id: oid(TARGET.mirrorId),
		__v: 0,
		hotelId: oid(TARGET.hotelId),
		hrIdFingerprint: "a".repeat(64),
		hotelRunnerReservationId: TARGET.hotelRunnerReservationId,
		hrNumber: TARGET.hrNumber,
		providerNumber: TARGET.otaBookingId,
		channel: "expedia",
		state: "reserved",
		observedSourceUpdatedAt: new Date("2026-08-09T02:14:00.000Z"),
		observedCanonicalHash: TARGET.eventCanonicalHash,
		appliedCanonicalHash: TARGET.eventCanonicalHash,
		reservationMongoId: oid(TARGET.reservationMongoId),
		identityConflict: false,
		projectionVersion: 1,
		projectionStatus: "created",
	};
	const paymentSummary = {
		sourceCurrency: "USD",
		sourceTotalGuestPaymentAmount: TARGET.portalGuestGross,
		sourceNightlyRateAmount: 0,
		sourceTaxesAmount: 0,
		sourceExpediaCompensationAmount: 0,
		sourceAcceleratorAmount: 0,
		sourceTotalPayoutAmount: payout || 0,
		totalGuestPaymentAmount: 549.23,
		totalPayoutAmount: payout ? 423.45 : 0,
		currency: "SAR",
		propertyCurrency: "SAR",
		propertyConversionVerified: false,
		exchangeRateToSar: 3.75,
		exchangeRateSource: "fallback_default",
	};
	const candidate = {
		hotelId: TARGET.hotelId,
		hotelName: "Zad Ajyad",
		confirmationNumber: TARGET.otaBookingId,
		reservationId: TARGET.reservationMongoId,
		pmsConfirmationNumber: TARGET.pmsConfirmationNumber,
		matchedLookupValue: TARGET.otaBookingId,
		matchedReservationBy: ["reservation_id"],
		actionPreview: "matched_existing_no_write",
		checkinDate: TARGET.checkinDate,
		checkoutDate: TARGET.checkoutDate,
		sourceCurrency: "USD",
		sourceAmount: TARGET.portalGuestGross,
		amount: 549.23,
		currency: "SAR",
		propertyCurrency: "SAR",
		propertyConversionVerified: false,
		exchangeRateToSar: 3.75,
		exchangeRateSource: "fallback_default",
		paymentCollectionModel: "expedia_collect",
		detailsFetched: Boolean(payout),
		paymentSummary,
		sourceSnippet: "PRIVATE REDACTED Booking amount USD 146.46 Expedia Collect",
	};
	const job = {
		_id: oid(portalSelection.jobId),
		__v: 0,
		jobNumber: portalSelection.jobNumber,
		status: "preview_ready",
		provider: "expedia",
		operation: "reservation_sync_preview",
		executionMode: "supervised_read_only",
		createdBy: OWNER_ID,
		dateFrom: TARGET.portalDateFrom,
		dateTo: TARGET.portalDateTo,
		timezone: "Asia/Riyadh",
		hotelCount: 1,
		targetHotels: [{ hotelId: TARGET.hotelId, hotelName: "Zad Ajyad" }],
		previewBuckets: {
			newReservations: [],
			skippedCancelled: [],
			matchedExisting: [candidate],
			statusChanged: [],
			conflicts: [],
			needsReview: [],
			paymentOrVccAvailable: [],
		},
		collectorState: {
			status: "preview_ready",
			readOnly: true,
			selectedHotelIds: [TARGET.hotelId],
			selectedHotelCount: 1,
			finishedAt: new Date("2026-08-09T03:40:00.000Z"),
		},
		resultSummary: {
			matchedExisting: 1,
			appliedWrites: 0,
		},
		auditLog: [
			{
				at: new Date("2026-08-09T03:40:00.000Z"),
				action: "collector_finished",
				readOnly: true,
			},
		],
		createdAt: new Date("2026-08-09T03:38:15.000Z"),
		updatedAt: new Date("2026-08-09T03:40:00.000Z"),
	};
	return { reservation, event, mirror, job };
}

function fixtureDb(options = {}) {
	const source = fixture(options);
	return {
		source,
		db: new MemoryDb({
			[COLLECTIONS.reservation]: [source.reservation],
			[COLLECTIONS.event]: [source.event],
			[COLLECTIONS.mirror]: [source.mirror],
			[COLLECTIONS.portalJob]: [source.job],
		}),
	};
}

test("arguments enforce exact release, repair ID, proof, and rollback fencing", () => {
	assert.deepEqual(parseArguments([`--release-sha=${RELEASE_SHA}`]), {
		apply: false,
		rollback: false,
		repairId: "",
		releaseSha: RELEASE_SHA,
		proof: "",
		portalJobId: "",
		portalJobNumber: "",
	});
	assert.throws(() => parseArguments([]), /release-sha/);
	assert.throws(
		() =>
			parseArguments([
				"--apply",
				`--repair-id=${REPAIR_ID}`,
				`--release-sha=${RELEASE_SHA}`,
			]),
		/dry-run proof/
	);
	assert.throws(
		() => parseArguments(["--rollback", `--release-sha=${RELEASE_SHA}`]),
		/repair-id/
	);
	assert.throws(
		() =>
			parseArguments([
				`--release-sha=${RELEASE_SHA}`,
				`--portal-job-id=${CUSTOM_PORTAL_SELECTION.jobId}`,
			]),
		/requires both/
	);
	const customOptions = parseArguments([
		`--release-sha=${RELEASE_SHA}`,
		`--portal-job-id=${CUSTOM_PORTAL_SELECTION.jobId}`,
		`--portal-job-number=${CUSTOM_PORTAL_SELECTION.jobNumber}`,
	]);
	assert.deepEqual(portalSelectionFromArguments(customOptions), CUSTOM_PORTAL_SELECTION);
	assert.deepEqual(
		portalSelectionFromArguments(parseArguments([`--release-sha=${RELEASE_SHA}`])),
		DEFAULT_PORTAL_SELECTION
	);
	const proof = `${PLANNED_AT.getTime()}.${"b".repeat(64)}`;
	assert.equal(
		parseArguments([
			"--apply",
			`--repair-id=${REPAIR_ID}`,
			`--release-sha=${RELEASE_SHA}`,
			`--proof=${proof}`,
		]).proof,
		proof
	);
	assert.equal(
		parseProof(proof, new Date(PLANNED_AT.getTime() + 1000)).plannedAt.toISOString(),
		PLANNED_AT.toISOString()
	);
	assert.throws(
		() => parseProof(proof, new Date(PLANNED_AT.getTime() + 31 * 60 * 1000)),
		/expired/
	);
});

test("apply topology fencing accepts only a writable primary", async () => {
	await assert.doesNotReject(
		assertWritablePrimary({
			admin: () => ({ command: async () => ({ isWritablePrimary: true }) }),
		})
	);
	await assert.rejects(
		assertWritablePrimary({
			admin: () => ({ command: async () => ({ isWritablePrimary: false }) }),
		}),
		/writable MongoDB primary/
	);
});

test("the exact portal evidence preserves USD gross and SAR root but promotes no unsafe SAR money", () => {
	const source = fixture();
	const built = buildCommercialEvidence(source);
	assert.equal(built.payout, null);
	assert.equal(built.evidence.verificationState, "partial");
	assert.equal(built.evidence.roles.guestGross.sourceAmount, 146.46);
	assert.equal(built.evidence.roles.guestGross.sourceCurrency, "USD");
	assert.equal(built.evidence.roles.guestGross.propertyAmount, null);
	assert.equal(built.evidence.roles.hotelBase.propertyAmount, 534);
	assert.equal(built.evidence.roles.hotelPayout.sourceAmount, null);
	assert.equal(built.evidence.roles.deductionAggregate.sourceAmount, null);
	assert.equal(built.evidence.roles.explicitOtaCommission.sourceAmount, null);
	assert.equal(built.evidence.hotelRunnerReportedAmount.role, "unknown");
	assert.equal(built.evidence.currencyConversion, null);

	const expected = buildExpectedDocument({
		...source,
		releaseSha: RELEASE_SHA,
		repairAt: PLANNED_AT,
	}).expectedDocument;
	assert.equal(expected.total_amount, null);
	assert.equal(expected.adminPricing.clientTotal, null);
	assert.equal(expected.adminPricing.netAfterExpensesTotal, null);
	assert.equal(expected.ota_financial_summary.clientTotal, null);
	assert.equal(expected.ota_financial_summary.netAfterExpenses, null);
	assert.equal(expected.commission, 0);
	assert.equal(expected.commission_ota, null);
	assert.equal(expected.adminPricing.defaultDeductionRate, null);
	assert.equal(expected.adminPricing.exchangeRateToSar, null);
	assert.equal(expected.adminPricing.sourceExchangeRateToSar, null);
	assert.equal(expected.ota_financial_summary.sourceExchangeRateToSar, null);
	assert.equal(expected.supplierData.otaAmountConvertedAt, null);
	assert.equal(expected.supplierData.otaExchangeRateToSar, null);
	assert.equal(expected.supplierData.otaSourceExchangeRateToSar, null);
	assert.equal(expected.supplierData.otaSourceAmount, TARGET.portalGuestGross);
	assert.equal(expected.sub_total, 534);
	assert.deepEqual(
		expected.pickedRoomsPricing[0].pricingByDay.map((day) => day.rootPrice),
		TARGET.dailyRoot
	);
	assert.ok(
		expected.pickedRoomsPricing[0].pricingByDay.every(
			(day) =>
				day.clientPrice === null &&
				day.netAfterExpenses === null &&
				day.otaExpenseAmount === null &&
				day.platformMargin === null
		)
	);
	assert.equal(
		canonicalEjsonSha256(commercialProtectedSnapshot(expected)),
		canonicalEjsonSha256(commercialProtectedSnapshot(source.reservation))
	);
	assert.deepEqual(
		expected.supplierData.hotelRunner,
		source.reservation.supplierData.hotelRunner
	);
	assert.deepEqual(expected.payment_details, source.reservation.payment_details);
	assert.deepEqual(expected.bofa_payment, source.reservation.bofa_payment);
});

test("an explicit exact portal payout remains USD-only, derives a separate deduction, and never invents commission", () => {
	const source = fixture({ payout: TARGET.hotelRunnerReportedAmount });
	const { evidence, payout } = buildCommercialEvidence(source);
	assert.equal(payout, 112.92);
	assert.equal(evidence.verificationState, "verified");
	assert.equal(evidence.roles.hotelPayout.sourceAmount, 112.92);
	assert.equal(evidence.roles.hotelPayout.propertyAmount, null);
	assert.equal(evidence.roles.deductionAggregate.sourceAmount, 33.54);
	assert.equal(evidence.roles.deductionAggregate.propertyAmount, null);
	assert.equal(evidence.roles.explicitOtaCommission.sourceAmount, null);
	assert.equal(evidence.hotelRunnerReportedAmount.role, "hotel_payout");
	assert.equal(evidence.hotelRunnerReportedAmount.roleVerified, true);
	const differentPortalPayout = buildCommercialEvidence(fixture({ payout: 110 }));
	assert.equal(differentPortalPayout.evidence.roles.hotelPayout.sourceAmount, 110);
	assert.equal(
		differentPortalPayout.evidence.roles.deductionAggregate.sourceAmount,
		36.46
	);
	assert.equal(
		differentPortalPayout.evidence.hotelRunnerReportedAmount.role,
		"unknown",
		"a different authenticated payout must not retroactively assign HotelRunner.total a role"
	);
	const unsafe = fixture({ payout: TARGET.hotelRunnerReportedAmount });
	unsafe.job.previewBuckets.matchedExisting[0].detailsFetched = false;
	assert.throws(() => buildCommercialEvidence(unsafe), /detail-page proof/);
	assert.throws(
		() => buildCommercialEvidence(fixture({ payout: 150 })),
		/compatible authenticated USD detail-page proof/
	);
});

test("source, identity, root, and pre-state drift fail before any plan is repairable", async () => {
	{
		const { db } = fixtureDb();
		db.collection(COLLECTIONS.portalJob).documents[0].previewBuckets.matchedExisting[0].sourceAmount = 140;
		await assert.rejects(
			loadPlan({ db, releaseSha: RELEASE_SHA, plannedAt: PLANNED_AT }),
			/USD 146\.46 gross/
		);
	}
	{
		const { db } = fixtureDb();
		db.collection(COLLECTIONS.reservation).documents[0].pickedRoomsPricing[0].pricingByDay[0].rootPrice = 88;
		await assert.rejects(
			loadPlan({ db, releaseSha: RELEASE_SHA, plannedAt: PLANNED_AT }),
			/protected root/
		);
	}
	{
		const { db } = fixtureDb();
		db.collection(COLLECTIONS.event).documents[0].payloadHash = "f".repeat(64);
		await assert.rejects(
			loadPlan({ db, releaseSha: RELEASE_SHA, plannedAt: PLANNED_AT }),
			/archived HotelRunner event/
		);
	}
});

test("an explicitly selected detail job is proof-bound through apply, idempotency, backup, and rollback", async () => {
	const { db } = fixtureDb({
		payout: TARGET.hotelRunnerReportedAmount,
		portalSelection: CUSTOM_PORTAL_SELECTION,
	});
	db.collection(COLLECTIONS.portalJob).documents[0].dateFrom = TARGET.checkinDate;
	db.collection(COLLECTIONS.portalJob).documents[0].dateTo = TARGET.checkoutDate;
	const plan = await loadPlan({
		db,
		releaseSha: RELEASE_SHA,
		plannedAt: PLANNED_AT,
		portalSelection: CUSTOM_PORTAL_SELECTION,
	});
	assert.equal(plan.state, "ready");
	assert.deepEqual(plan.portalSelection, CUSTOM_PORTAL_SELECTION);
	assert.equal(
		plan.evidence.provenance.primary.sourceId,
		CUSTOM_PORTAL_SELECTION.jobId
	);
	assert.equal(plan.evidence.roles.hotelPayout.sourceAmount, 112.92);
	assert.equal(
		plan.expectedDocument.supplierData.otaCommercialRepair.sourceJobId,
		CUSTOM_PORTAL_SELECTION.jobId
	);
	assert.equal(
		plan.expectedDocument.supplierData.otaCommercialRepair.sourceJobNumber,
		CUSTOM_PORTAL_SELECTION.jobNumber
	);
	assert.match(repairProofToken(plan), /^\d{13}\.[a-f0-9]{64}$/);

	const applied = await applyRepairPlan({ db, plan });
	assert.equal(applied.state, "applied");
	const manifest = db.collection(MANIFEST_COLLECTION).documents[0];
	assert.equal(manifest.portalJobId, CUSTOM_PORTAL_SELECTION.jobId);
	assert.equal(manifest.portalJobNumber, CUSTOM_PORTAL_SELECTION.jobNumber);
	assert.equal(manifest.portalJobHash, plan.sourceJobHash);
	const portalBackup = db
		.collection(BACKUP_COLLECTION)
		.documents.find((record) => record.role === "expedia_portal_job_evidence");
	assert.equal(portalBackup.documentId, CUSTOM_PORTAL_SELECTION.jobId);
	assert.equal(portalBackup.originalDocument.jobNumber, CUSTOM_PORTAL_SELECTION.jobNumber);

	// Even if the safe default job is still present, it cannot be substituted
	// for the explicitly selected source on an idempotent rerun or rollback.
	db.collection(COLLECTIONS.portalJob).documents.push(cloneBson(fixture().job));
	await assert.rejects(
		loadPlan({
			db,
			releaseSha: RELEASE_SHA,
			plannedAt: new Date(PLANNED_AT.getTime() + 30_000),
		}),
		/different selected portal job/
	);
	await assert.rejects(
		loadRollbackPlan({
			db,
			releaseSha: RELEASE_SHA,
			plannedAt: ROLLBACK_AT,
		}),
		/different selected portal job/
	);

	const rerun = await loadPlan({
		db,
		releaseSha: RELEASE_SHA,
		plannedAt: new Date(PLANNED_AT.getTime() + 30_000),
		portalSelection: CUSTOM_PORTAL_SELECTION,
	});
	assert.equal(rerun.state, "already_applied");
	assert.deepEqual(rerun.portalSelection, CUSTOM_PORTAL_SELECTION);
	const rollbackPlan = await loadRollbackPlan({
		db,
		releaseSha: RELEASE_SHA,
		plannedAt: ROLLBACK_AT,
		portalSelection: CUSTOM_PORTAL_SELECTION,
	});
	assert.equal(rollbackPlan.state, "ready");
	assert.deepEqual(rollbackPlan.portalSelection, CUSTOM_PORTAL_SELECTION);
	assert.match(rollbackProofToken(rollbackPlan), /^\d{13}\.[a-f0-9]{64}$/);
	const rolledBack = await applyRollbackPlan({ db, plan: rollbackPlan });
	assert.equal(rolledBack.state, "rolled_back");
	assert.equal(rolledBack.vendorApiCalls, 0);
});

test("one proof-gated CAS keeps four full EJSON backups, is idempotent, and rolls back exactly", async () => {
	const { db, source } = fixtureDb();
	const originalHash = canonicalEjsonSha256(source.reservation);
	const plan = await loadPlan({ db, releaseSha: RELEASE_SHA, plannedAt: PLANNED_AT });
	assert.equal(plan.state, "ready");
	assert.match(repairProofToken(plan), /^\d{13}\.[a-f0-9]{64}$/);
	assert.equal(db.collection(MANIFEST_COLLECTION).documents.length, 0);
	assert.equal(db.collection(BACKUP_COLLECTION).documents.length, 0);

	const applied = await applyRepairPlan({ db, plan });
	assert.equal(applied.state, "applied");
	assert.equal(applied.changed, 1);
	assert.equal(applied.vendorApiCalls, 0);
	assert.match(applied.backupSetSha256, /^[a-f0-9]{64}$/);
	const manifest = db.collection(MANIFEST_COLLECTION).documents[0];
	assert.equal(manifest.state, "applied");
	assert.equal(manifest.releaseSha, RELEASE_SHA);
	assert.equal(manifest.originalHash, originalHash);
	assert.equal(manifest.expectedRepairedHash, plan.expectedHash);
	assert.equal(manifest.vendorApiCalls, 0);
	const backupRecords = db.collection(BACKUP_COLLECTION).documents;
	assert.equal(backupRecords.length, 4);
	const verified = verifyBackupRecords(backupRecords, manifest);
	assert.equal(verified.backupSetSha256, applied.backupSetSha256);
	for (const record of backupRecords) {
		assert.ok(record.originalEjson.length > 0);
		assert.match(record.originalEjsonSha256, /^[a-f0-9]{64}$/);
		assert.equal(canonicalEjsonSha256(record.originalDocument), record.originalHash);
	}
	const repaired = db.collection(COLLECTIONS.reservation).documents[0];
	assert.equal(canonicalEjsonSha256(repaired), plan.expectedHash);
	assert.equal(repaired.__v, 2);
	assert.equal(repaired.total_amount, null);
	assert.equal(repaired.supplierData.otaCommercialRepair.vendorApiCalls, 0);
	assert.deepEqual(repaired.customer_details, source.reservation.customer_details);
	assert.deepEqual(repaired.payment_details, source.reservation.payment_details);
	assert.deepEqual(repaired.bofa_payment, source.reservation.bofa_payment);
	assert.deepEqual(
		repaired.supplierData.hotelRunner,
		source.reservation.supplierData.hotelRunner
	);

	const rerun = await loadPlan({
		db,
		releaseSha: RELEASE_SHA,
		plannedAt: new Date(PLANNED_AT.getTime() + 60_000),
	});
	assert.equal(rerun.state, "already_applied");
	const idempotent = await applyRepairPlan({ db, plan: rerun });
	assert.deepEqual(
		{
			state: idempotent.state,
			changed: idempotent.changed,
			vendorApiCalls: idempotent.vendorApiCalls,
		},
		{ state: "already_applied", changed: 0, vendorApiCalls: 0 }
	);
	assert.equal(db.collection(COLLECTIONS.reservation).replaceCalls, 1);

	const rollbackPlan = await loadRollbackPlan({
		db,
		releaseSha: RELEASE_SHA,
		plannedAt: ROLLBACK_AT,
	});
	assert.equal(rollbackPlan.state, "ready");
	assert.match(rollbackProofToken(rollbackPlan), /^\d{13}\.[a-f0-9]{64}$/);
	const rolledBack = await applyRollbackPlan({ db, plan: rollbackPlan });
	assert.equal(rolledBack.state, "rolled_back");
	assert.equal(rolledBack.changed, 1);
	assert.equal(rolledBack.vendorApiCalls, 0);
	assert.equal(
		canonicalEjsonSha256(db.collection(COLLECTIONS.reservation).documents[0]),
		originalHash
	);
	assert.equal(db.collection(MANIFEST_COLLECTION).documents[0].state, "rolled_back");
	assert.equal(db.collection(BACKUP_COLLECTION).documents.length, 4);
	assert.equal(db.collection(COLLECTIONS.reservation).replaceCalls, 2);

	const rollbackRerun = await loadRollbackPlan({
		db,
		releaseSha: RELEASE_SHA,
		plannedAt: new Date(ROLLBACK_AT.getTime() + 60_000),
	});
	assert.equal(rollbackRerun.state, "already_rolled_back");
	const secondRollback = await applyRollbackPlan({ db, plan: rollbackRerun });
	assert.equal(secondRollback.state, "already_rolled_back");
	assert.equal(secondRollback.changed, 0);
	assert.equal(db.collection(COLLECTIONS.reservation).replaceCalls, 2);
});
