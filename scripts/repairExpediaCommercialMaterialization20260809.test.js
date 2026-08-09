/** @format */

"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { ObjectId } = require("bson");

const v1 = require("./repairExpediaCommercialEnrichment20260809");
const {
	BACKUP_COLLECTION,
	COLLECTIONS,
	MANIFEST_COLLECTION,
	REPAIR_ID,
	TARGET,
	allocateCentsByWeight,
	applyRepairPlan,
	applyRollbackPlan,
	loadPlan,
	loadRollbackPlan,
	main,
	parseArguments,
	proofToken,
	sanitizedForwardOutput,
	verifyBackupRecords,
} = require("./repairExpediaCommercialMaterialization20260809");
const {
	canonicalEjsonSha256,
	cloneBson,
} = require("../services/recentOtaInboundRecovery20260805");

const RELEASE_SHA = "c".repeat(40);
const V1_RELEASE_SHA = "a".repeat(40);
const V1_PLANNED_AT = new Date("2026-08-09T04:15:00.000Z");
const OWNER_ID = new ObjectId("68b74714fb50e159d48c714d");
const PORTAL_SELECTION = Object.freeze({
	jobId: "6a77f999cdbc8acbbe4968a6",
	jobNumber: "OTA-RES-SYNC-20260809120000-ABCDE",
});

const oid = (value) => new ObjectId(value);
const getPath = (document, pathText) =>
	String(pathText)
		.split(".")
		.reduce(
			(current, key) => (current == null ? undefined : current[key]),
			document
		);

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
		if (
			this.documents.some((candidate) => equal(candidate._id, document._id))
		) {
			throw new Error("duplicate key");
		}
		this.documents.push(cloneBson(document));
		return { acknowledged: true, insertedId: document._id };
	}

	async replaceOne(filter, replacement) {
		this.replaceCalls += 1;
		const index = this.documents.findIndex((document) =>
			matches(document, filter)
		);
		if (index < 0) {
			return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
		}
		this.documents[index] = cloneBson(replacement);
		return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
	}

	async updateOne(filter, update) {
		const document = this.documents.find((candidate) =>
			matches(candidate, filter)
		);
		if (!document)
			return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
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

	admin() {
		return {
			async command() {
				return { isWritablePrimary: true };
			},
		};
	}
}

function v1NightlyRows() {
	return TARGET.dailyRoot.map((rootPrice, index) => {
		const date = new Date(TARGET.checkinDate + "T00:00:00.000Z");
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
			hotelRunnerSourcePrice: TARGET.dailyHotelRunnerSource[index],
		};
	});
}

function v1Fixture() {
	const pricingByDay = v1NightlyRows();
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
		checkin_date: new Date(TARGET.checkinDate + "T00:00:00.000Z"),
		checkout_date: new Date(TARGET.checkoutDate + "T00:00:00.000Z"),
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
							nightly: TARGET.dailyHotelRunnerSource.map(
								(finalPrice, index) => {
									const date = new Date(TARGET.checkinDate + "T00:00:00.000Z");
									date.setUTCDate(date.getUTCDate() + index);
									return {
										date: date.toISOString().slice(0, 10),
										finalPrice,
									};
								}
							),
						},
					],
				},
			},
		},
		reservationAuditLog: [
			{ at: new Date("2026-08-09T02:16:00.000Z"), action: "created" },
		],
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
	const candidate = {
		hotelId: TARGET.hotelId,
		confirmationNumber: TARGET.otaBookingId,
		reservationId: TARGET.reservationMongoId,
		pmsConfirmationNumber: TARGET.pmsConfirmationNumber,
		matchedLookupValue: TARGET.otaBookingId,
		actionPreview: "matched_existing_no_write",
		checkinDate: TARGET.checkinDate,
		checkoutDate: TARGET.checkoutDate,
		sourceCurrency: "USD",
		sourceAmount: TARGET.portalGuestGross,
		amount: null,
		currency: "USD",
		propertyCurrency: "SAR",
		propertyConversionVerified: false,
		exchangeRateToSar: 3.75,
		exchangeRateSource: "fallback_default",
		paymentCollectionModel: "expedia_collect",
		detailsFetched: true,
		paymentSummary: {
			sourceCurrency: "USD",
			sourceTotalGuestPaymentAmount: TARGET.portalGuestGross,
			sourceNightlyRateAmount: null,
			sourceTaxesAmount: null,
			sourceExpediaCompensationAmount: null,
			sourceAcceleratorAmount: null,
			sourceTotalPayoutAmount: TARGET.hotelRunnerReportedAmount,
			totalGuestPaymentAmount: null,
			totalPayoutAmount: null,
			currency: null,
			propertyCurrency: "SAR",
			propertyConversionVerified: false,
			exchangeRateToSar: 3.75,
			exchangeRateSource: "fallback_default",
		},
	};
	const job = {
		_id: oid(v1.DEFAULT_PORTAL_SELECTION.jobId),
		__v: 0,
		jobNumber: v1.DEFAULT_PORTAL_SELECTION.jobNumber,
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
		resultSummary: { matchedExisting: 1, appliedWrites: 0 },
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

function v2Job({ createdAt, rate = 3.75 } = {}) {
	const created = new Date(createdAt);
	const convertedAt = new Date(created.getTime() + 30_000);
	const finishedAt = new Date(created.getTime() + 60_000);
	const sourceTimestamp = new Date(created.getTime() - 6 * 60 * 60_000);
	const normalizedRate = Number(Number(rate).toFixed(10));
	const sourceHash = crypto
		.createHash("sha256")
		.update(
			JSON.stringify({
				provider: "exchange_rate_api",
				sourceType: "trusted_exchange_evidence",
				sourceCurrency: "USD",
				propertyCurrency: "SAR",
				rate: normalizedRate,
				sourceTimestamp: sourceTimestamp.toISOString(),
			})
		)
		.digest("hex");
	const gross = round2(TARGET.portalGuestGross * rate);
	const payout = round2(TARGET.hotelRunnerReportedAmount * rate);
	const conversion = {
		trusted: true,
		verified: true,
		sourceCurrency: "USD",
		propertyCurrency: "SAR",
		rate: normalizedRate,
		provenance: {
			provider: "exchange_rate_api",
			sourceType: "trusted_exchange_evidence",
			sourceHash,
			sourceTimestamp: sourceTimestamp.toISOString(),
			sourceId: "exchange-rate-api-usd-sar-" + sourceHash.slice(0, 24),
		},
	};
	const candidate = {
		hotelId: TARGET.hotelId,
		confirmationNumber: TARGET.otaBookingId,
		reservationId: TARGET.reservationMongoId,
		pmsConfirmationNumber: TARGET.pmsConfirmationNumber,
		matchedLookupValue: TARGET.otaBookingId,
		actionPreview: "matched_existing_no_write",
		checkinDate: TARGET.checkinDate,
		checkoutDate: TARGET.checkoutDate,
		sourceCurrency: "USD",
		sourceAmount: TARGET.portalGuestGross,
		sourcePayoutAmount: TARGET.hotelRunnerReportedAmount,
		sourcePayoutCurrency: "USD",
		totalAmountSar: gross,
		totalPayoutSar: payout,
		netAfterExpensesTotal: payout,
		amount: gross,
		currency: "SAR",
		propertyCurrency: "SAR",
		propertyConversionVerified: true,
		exchangeRateToSar: rate,
		exchangeRateSource: "exchange_rate_api",
		amountConvertedAt: convertedAt.toISOString(),
		currencyConversionEvidence: conversion,
		paymentCollectionModel: "expedia_collect",
		detailsFetched: true,
		sourceSnippet: "PRIVATE SOURCE CONTENT MUST NEVER BE LOGGED",
		paymentSummary: {
			sourceCurrency: "USD",
			sourceNightlyRateAmount: null,
			sourceTaxesAmount: null,
			sourceTotalGuestPaymentAmount: TARGET.portalGuestGross,
			sourceExpediaCompensationAmount: null,
			sourceAcceleratorAmount: null,
			sourceTotalPayoutAmount: TARGET.hotelRunnerReportedAmount,
			sourceTotalPayoutCurrency: "USD",
			nightlyRateAmount: null,
			taxesAmount: null,
			totalGuestPaymentAmount: gross,
			expediaCompensationAmount: null,
			acceleratorAmount: null,
			totalPayoutAmount: payout,
			currency: "SAR",
			propertyCurrency: "SAR",
			propertyConversionVerified: true,
			exchangeRateToSar: rate,
			exchangeRateSource: "exchange_rate_api",
			amountConvertedAt: convertedAt.toISOString(),
		},
	};
	return {
		_id: oid(PORTAL_SELECTION.jobId),
		__v: 0,
		jobNumber: PORTAL_SELECTION.jobNumber,
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
			finishedAt,
		},
		resultSummary: { matchedExisting: 1, appliedWrites: 0 },
		auditLog: [
			{ at: finishedAt, action: "collector_finished", readOnly: true },
		],
		createdAt: created,
		updatedAt: finishedAt,
	};
}

const round2 = (value) => Number(Number(value).toFixed(2));

async function preparedFixture({ rate = 3.75 } = {}) {
	const source = v1Fixture();
	const db = new MemoryDb({
		[COLLECTIONS.reservation]: [source.reservation],
		[COLLECTIONS.event]: [source.event],
		[COLLECTIONS.mirror]: [source.mirror],
		[COLLECTIONS.portalJob]: [source.job],
	});
	const v1Plan = await v1.loadPlan({
		db,
		releaseSha: V1_RELEASE_SHA,
		plannedAt: V1_PLANNED_AT,
		portalSelection: v1.DEFAULT_PORTAL_SELECTION,
	});
	await v1.applyRepairPlan({ db, plan: v1Plan });
	const v1Manifest = await db
		.collection(v1.MANIFEST_COLLECTION)
		.findOne({ _id: v1.REPAIR_ID });
	const createdAt = new Date(new Date(v1Manifest.appliedAt).getTime() + 60_000);
	const job = v2Job({ createdAt, rate });
	db.collection(COLLECTIONS.portalJob).documents.push(cloneBson(job));
	const plannedAt = new Date(
		new Date(job.collectorState.finishedAt).getTime() + 60_000
	);
	return {
		db,
		source,
		job,
		plannedAt,
		v1Plan,
		v1Manifest,
		v1ManifestHash: canonicalEjsonSha256(v1Manifest),
		v1BackupHashes: db
			.collection(v1.BACKUP_COLLECTION)
			.documents.map((record) => record.recordHash),
	};
}

async function readyPlan(fixture) {
	return loadPlan({
		db: fixture.db,
		releaseSha: RELEASE_SHA,
		plannedAt: fixture.plannedAt,
		portalSelection: PORTAL_SELECTION,
	});
}

test("v2 CLI requires explicit fresh evidence selectors and exact proof fencing", () => {
	assert.throws(
		() => parseArguments(["--release-sha=" + RELEASE_SHA]),
		/fresh portal evidence/
	);
	const dryRun = parseArguments([
		"--release-sha=" + RELEASE_SHA,
		"--portal-job-id=" + PORTAL_SELECTION.jobId,
		"--portal-job-number=" + PORTAL_SELECTION.jobNumber,
	]);
	assert.equal(dryRun.apply, false);
	assert.equal(dryRun.portalJobId, PORTAL_SELECTION.jobId);
	assert.throws(
		() =>
			parseArguments([
				"--apply",
				"--repair-id=" + REPAIR_ID,
				"--release-sha=" + RELEASE_SHA,
				"--portal-job-id=" + PORTAL_SELECTION.jobId,
				"--portal-job-number=" + PORTAL_SELECTION.jobNumber,
			]),
		/dry-run proof/
	);
});

test("v2 has no vendor client, HTTP, fetch, or reservation-create execution path", () => {
	const source = fs.readFileSync(
		path.resolve(
			__dirname,
			"repairExpediaCommercialMaterialization20260809.js"
		),
		"utf8"
	);
	assert.doesNotMatch(
		source,
		/require\([^\n]*(hotelrunnerClient|expediaReservationCollector|node:https|node:http|axios)/
	);
	assert.doesNotMatch(source, /\bfetch\s*\(/);
	assert.doesNotMatch(
		source,
		/Reservations\.(create|insertMany)|new\s+Reservations\b/
	);
});

test("dry run dynamically materializes 3.75 evidence and cent-exact weighted nights", async () => {
	const fixture = await preparedFixture();
	const plan = await readyPlan(fixture);
	assert.equal(plan.state, "ready");
	assert.equal(fixture.db.collection(BACKUP_COLLECTION).documents.length, 0);
	assert.equal(
		fixture.db
			.collection(MANIFEST_COLLECTION)
			.documents.filter((entry) => entry._id === REPAIR_ID).length,
		0
	);
	assert.equal(plan.commercial.conversion.rate, 3.75);
	assert.equal(plan.commercial.gross, 549.23);
	assert.equal(plan.commercial.payout, 423.45);
	assert.equal(plan.commercial.deduction, 125.78);
	assert.equal(plan.commercial.margin, -110.55);
	const expected = plan.expectedDocument;
	assert.equal(expected.__v, 3);
	assert.equal(expected.total_amount, 549.23);
	assert.equal(expected.commission, 0);
	assert.equal(expected.commission_ota, null);
	assert.equal(expected.adminPricing.clientTotal, 549.23);
	assert.equal(expected.adminPricing.netAfterExpensesTotal, 423.45);
	assert.equal(expected.adminPricing.otaExpenseTotal, 125.78);
	assert.equal(expected.adminPricing.platformMarginTotal, -110.55);
	assert.equal(expected.supplierData.otaAmount, 146.46);
	assert.equal(expected.supplierData.otaSourceAmount, 146.46);
	assert.equal(expected.supplierData.otaTotalPayoutSar, 423.45);
	assert.equal(expected.supplierData.otaCommissionSar, null);
	assert.equal(
		expected.supplierData.otaCommercialRepair.repairId,
		v1.REPAIR_ID
	);
	assert.equal(
		expected.supplierData.otaCommercialMaterializationRepair.repairId,
		REPAIR_ID
	);
	const days = expected.pickedRoomsPricing[0].pricingByDay;
	assert.deepEqual(
		days.map((day) => day.clientPrice),
		[91.54, 91.54, 91.54, 91.54, 91.54, 91.53]
	);
	assert.deepEqual(
		days.map((day) => day.netAfterExpenses),
		[70.58, 70.58, 70.58, 70.57, 70.57, 70.57]
	);
	assert.equal(
		round2(days.reduce((sum, day) => sum + day.otaExpenseAmount, 0)),
		125.78
	);
	assert.equal(
		round2(days.reduce((sum, day) => sum + day.platformMargin, 0)),
		-110.55
	);
	assert.deepEqual(allocateCentsByWeight(10, [1, 2, 3]), [1.67, 3.33, 5]);
	const repeat = await readyPlan(fixture);
	assert.equal(repeat.planHash, plan.planHash);
	assert.equal(proofToken(repeat), proofToken(plan));
});

test("the trusted rate is dynamic rather than hard-coded to 3.75", async () => {
	const fixture = await preparedFixture({ rate: 4 });
	const plan = await readyPlan(fixture);
	assert.equal(plan.commercial.gross, 585.84);
	assert.equal(plan.commercial.payout, 451.68);
	assert.equal(plan.commercial.deduction, 134.16);
	assert.equal(plan.commercial.margin, -82.32);
	assert.equal(plan.expectedDocument.total_amount, 585.84);
	assert.equal(plan.expectedDocument.supplierData.otaExchangeRateToSar, 4);
});

test("apply creates a separate immutable backup and preserves all v1 artifacts", async () => {
	const fixture = await preparedFixture();
	const plan = await readyPlan(fixture);
	const evidenceHashesBefore = {
		event: canonicalEjsonSha256(
			fixture.db.collection(COLLECTIONS.event).documents[0]
		),
		mirror: canonicalEjsonSha256(
			fixture.db.collection(COLLECTIONS.mirror).documents[0]
		),
		portal: canonicalEjsonSha256(
			fixture.db.collection(COLLECTIONS.portalJob).documents[1]
		),
	};
	const v1ManifestBefore = cloneBson(
		await fixture.db
			.collection(v1.MANIFEST_COLLECTION)
			.findOne({ _id: v1.REPAIR_ID })
	);
	const v1BackupsBefore = cloneBson(
		fixture.db.collection(v1.BACKUP_COLLECTION).documents
	);
	const result = await applyRepairPlan({ db: fixture.db, plan });
	assert.equal(result.state, "applied");
	assert.equal(result.changed, 1);
	assert.equal(
		fixture.db.collection(COLLECTIONS.reservation).replaceCalls,
		2,
		"one v1 CAS plus one v2 CAS"
	);
	const repaired = await fixture.db
		.collection(COLLECTIONS.reservation)
		.findOne({ _id: oid(TARGET.reservationMongoId) });
	assert.equal(canonicalEjsonSha256(repaired), plan.expectedHash);
	assert.equal(repaired.payment_details.captured, false);
	assert.equal(repaired.bofa_payment.vcc.secretSentinel, "must-survive");
	assert.equal(
		repaired.supplierData.hotelRunner.immutableRawSentinel.untouched,
		true
	);
	assert.equal(fixture.db.collection(BACKUP_COLLECTION).documents.length, 4);
	const manifest = await fixture.db
		.collection(MANIFEST_COLLECTION)
		.findOne({ _id: REPAIR_ID });
	assert.equal(manifest.state, "applied");
	assert.equal(manifest.appliedDocumentHash, plan.expectedHash);
	assert.equal(manifest.predecessorManifestHash, fixture.v1ManifestHash);
	assert.equal(manifest.backupRecordCount, 4);
	assert.deepEqual(Object.keys(manifest.backupRecordHashes).sort(), [
		"expedia_portal_job_evidence",
		"hotelrunner_event_evidence",
		"hotelrunner_mirror_evidence",
		"reservation_before",
	]);
	const verifiedBackup = verifyBackupRecords(
		fixture.db.collection(BACKUP_COLLECTION).documents,
		manifest
	);
	assert.equal(verifiedBackup.backupSetSha256, manifest.backupSetSha256);
	assert.equal(
		canonicalEjsonSha256(fixture.db.collection(COLLECTIONS.event).documents[0]),
		evidenceHashesBefore.event
	);
	assert.equal(
		canonicalEjsonSha256(
			fixture.db.collection(COLLECTIONS.mirror).documents[0]
		),
		evidenceHashesBefore.mirror
	);
	assert.equal(
		canonicalEjsonSha256(
			fixture.db.collection(COLLECTIONS.portalJob).documents[1]
		),
		evidenceHashesBefore.portal
	);
	assert.equal(
		canonicalEjsonSha256(
			await fixture.db
				.collection(v1.MANIFEST_COLLECTION)
				.findOne({ _id: v1.REPAIR_ID })
		),
		canonicalEjsonSha256(v1ManifestBefore)
	);
	assert.equal(
		canonicalEjsonSha256(fixture.db.collection(v1.BACKUP_COLLECTION).documents),
		canonicalEjsonSha256(v1BackupsBefore)
	);
});

test("an applied plan reruns idempotently without a second v2 replacement", async () => {
	const fixture = await preparedFixture();
	const plan = await readyPlan(fixture);
	await applyRepairPlan({ db: fixture.db, plan });
	const replaceCalls = fixture.db.collection(
		COLLECTIONS.reservation
	).replaceCalls;
	const rerun = await readyPlan(fixture);
	assert.equal(rerun.state, "already_applied");
	const result = await applyRepairPlan({ db: fixture.db, plan: rerun });
	assert.equal(result.state, "already_applied");
	assert.equal(result.changed, 0);
	assert.equal(
		fixture.db.collection(COLLECTIONS.reservation).replaceCalls,
		replaceCalls
	);
});

test("full-document CAS blocks any post-plan reservation change", async () => {
	const fixture = await preparedFixture();
	const plan = await readyPlan(fixture);
	const live = fixture.db.collection(COLLECTIONS.reservation).documents[0];
	live.internalConcurrentSentinel = "changed-after-plan";
	await assert.rejects(
		() => applyRepairPlan({ db: fixture.db, plan }),
		/reservation changed after/
	);
	assert.equal(
		fixture.db.collection(COLLECTIONS.reservation).replaceCalls,
		1,
		"only the earlier v1 replacement ran"
	);
	assert.equal(
		fixture.db.collection(COLLECTIONS.reservation).documents[0]
			.internalConcurrentSentinel,
		"changed-after-plan"
	);
});

test("lifecycle, manual, settled, and housed states independently block planning", async () => {
	const mutations = [
		(reservation) => {
			reservation.reservation_status = "cancelled";
		},
		(reservation) => {
			reservation.adminChangeLog = [{ action: "manual pricing" }];
		},
		(reservation) => {
			reservation.paid_amount = 10;
		},
		(reservation) => {
			reservation.financial_cycle = {
				status: "settled",
				settledAt: new Date(),
			};
		},
		(reservation) => {
			reservation.roomId = [oid("6a40df5f1a6d1850eb25c183")];
		},
	];
	for (const mutate of mutations) {
		const fixture = await preparedFixture();
		mutate(fixture.db.collection(COLLECTIONS.reservation).documents[0]);
		await assert.rejects(() => readyPlan(fixture));
		assert.equal(
			fixture.db.collection(COLLECTIONS.reservation).replaceCalls,
			1,
			"no v2 replacement is attempted"
		);
	}
});

test("tampered conversion evidence and stale collector evidence fail closed", async () => {
	{
		const fixture = await preparedFixture();
		const candidate = fixture.db.collection(COLLECTIONS.portalJob).documents[1]
			.previewBuckets.matchedExisting[0];
		candidate.currencyConversionEvidence.provenance.sourceHash = "f".repeat(64);
		await assert.rejects(() => readyPlan(fixture), /trusted exact contract/);
	}
	{
		const fixture = await preparedFixture();
		const candidate = fixture.db.collection(COLLECTIONS.portalJob).documents[1]
			.previewBuckets.matchedExisting[0];
		candidate.currencyConversionEvidence.rate = 3.8;
		await assert.rejects(() => readyPlan(fixture), /trusted exact contract/);
	}
	{
		const fixture = await preparedFixture();
		const job = fixture.db.collection(COLLECTIONS.portalJob).documents[1];
		const old = new Date(
			new Date(fixture.v1Manifest.appliedAt).getTime() - 60_000
		);
		job.createdAt = old;
		await assert.rejects(() => readyPlan(fixture), /not fresh after v1/);
	}
});

test("cached/stored FX markers and bounded collector audit skew retain exact provenance", async () => {
	for (const marker of [
		"exchange_rate_api_cached",
		"exchange_rate_api_stored",
	]) {
		const fixture = await preparedFixture();
		const job = fixture.db.collection(COLLECTIONS.portalJob).documents[1];
		const candidate = job.previewBuckets.matchedExisting[0];
		candidate.exchangeRateSource = marker;
		candidate.paymentSummary.exchangeRateSource = marker;
		if (marker === "exchange_rate_api_cached") {
			const cachedFetch = new Date(
				new Date(job.createdAt).getTime() - 2 * 60 * 60_000
			).toISOString();
			candidate.amountConvertedAt = cachedFetch;
			candidate.paymentSummary.amountConvertedAt = cachedFetch;
		}
		job.auditLog[0].at = new Date(
			new Date(job.collectorState.finishedAt).getTime() + 2
		);
		const plan = await readyPlan(fixture);
		assert.equal(plan.state, "ready");
		assert.equal(
			plan.commercial.conversion.provenance.sourceType,
			"trusted_exchange_evidence"
		);
	}
});

test("portal evidence tampered after planning is caught before the v2 CAS", async () => {
	const fixture = await preparedFixture();
	const plan = await readyPlan(fixture);
	fixture.db.collection(COLLECTIONS.portalJob).documents[1].sourceTamper = true;
	await assert.rejects(
		() => applyRepairPlan({ db: fixture.db, plan }),
		/Immutable v2 evidence changed/
	);
	assert.equal(fixture.db.collection(COLLECTIONS.reservation).replaceCalls, 1);
});

test("tampered v1 manifest or backup prevents v2 planning and application", async () => {
	{
		const fixture = await preparedFixture();
		const record = fixture.db.collection(v1.BACKUP_COLLECTION).documents[0];
		record.originalDocument.state = "tampered";
		await assert.rejects(() => readyPlan(fixture), /integrity failed/);
	}
	{
		const fixture = await preparedFixture();
		fixture.db.collection(
			COLLECTIONS.event
		).documents[0].payload.reservation.total = 999;
		await assert.rejects(() => readyPlan(fixture), /immutable archive/);
	}
	{
		const fixture = await preparedFixture();
		const plan = await readyPlan(fixture);
		const manifest = fixture.db
			.collection(v1.MANIFEST_COLLECTION)
			.documents.find((entry) => entry._id === v1.REPAIR_ID);
		manifest.evidenceHash = "0".repeat(64);
		await assert.rejects(
			() => applyRepairPlan({ db: fixture.db, plan }),
			/v1 post-state cannot be reconstructed|v1 predecessor proof changed/
		);
		assert.equal(
			fixture.db.collection(COLLECTIONS.reservation).replaceCalls,
			1
		);
	}
});

test("rollback restores exact v1 EJSON and is idempotent without touching v1 proof", async () => {
	const fixture = await preparedFixture();
	const plan = await readyPlan(fixture);
	const v1DocumentHash = plan.originalHash;
	const v1ManifestBefore = canonicalEjsonSha256(
		await fixture.db
			.collection(v1.MANIFEST_COLLECTION)
			.findOne({ _id: v1.REPAIR_ID })
	);
	const v1BackupsBefore = canonicalEjsonSha256(
		fixture.db.collection(v1.BACKUP_COLLECTION).documents
	);
	await applyRepairPlan({ db: fixture.db, plan });
	const rollbackAt = new Date(fixture.plannedAt.getTime() + 10 * 60_000);
	const rollback = await loadRollbackPlan({
		db: fixture.db,
		releaseSha: RELEASE_SHA,
		plannedAt: rollbackAt,
		portalSelection: PORTAL_SELECTION,
	});
	assert.equal(rollback.state, "ready");
	const result = await applyRollbackPlan({ db: fixture.db, plan: rollback });
	assert.equal(result.state, "rolled_back");
	assert.equal(result.changed, 1);
	const restored = await fixture.db
		.collection(COLLECTIONS.reservation)
		.findOne({ _id: oid(TARGET.reservationMongoId) });
	assert.equal(canonicalEjsonSha256(restored), v1DocumentHash);
	assert.equal(restored.__v, 2);
	assert.equal(
		restored.supplierData.otaCommercialRepair.repairId,
		v1.REPAIR_ID
	);
	assert.equal(
		restored.supplierData.otaCommercialMaterializationRepair,
		undefined
	);
	assert.equal(
		canonicalEjsonSha256(
			await fixture.db
				.collection(v1.MANIFEST_COLLECTION)
				.findOne({ _id: v1.REPAIR_ID })
		),
		v1ManifestBefore
	);
	assert.equal(
		canonicalEjsonSha256(fixture.db.collection(v1.BACKUP_COLLECTION).documents),
		v1BackupsBefore
	);
	const rerun = await loadRollbackPlan({
		db: fixture.db,
		releaseSha: RELEASE_SHA,
		plannedAt: new Date(rollbackAt.getTime() + 60_000),
		portalSelection: PORTAL_SELECTION,
	});
	assert.equal(rerun.state, "already_rolled_back");
	const idempotent = await applyRollbackPlan({ db: fixture.db, plan: rerun });
	assert.equal(idempotent.changed, 0);
});

test("rollback dry-run proof is required and applies only its exact release/scope", async () => {
	const fixture = await preparedFixture();
	const baseArgs = [
		"--release-sha=" + RELEASE_SHA,
		"--portal-job-id=" + PORTAL_SELECTION.jobId,
		"--portal-job-number=" + PORTAL_SELECTION.jobNumber,
	];
	const messages = [];
	const originalLog = console.log;
	console.log = (value) => messages.push(String(value));
	try {
		const dry = await main(baseArgs, {
			db: fixture.db,
			clock: () => fixture.plannedAt,
			resolveReleaseSha: () => RELEASE_SHA,
		});
		const applied = await main(
			[
				"--apply",
				"--repair-id=" + REPAIR_ID,
				"--proof=" + dry.proof,
				...baseArgs,
			],
			{
				db: fixture.db,
				clock: () => new Date(fixture.plannedAt.getTime() + 60_000),
				resolveReleaseSha: () => RELEASE_SHA,
			}
		);
		assert.equal(applied.state, "applied");
		const rollbackDry = await main(
			["--rollback", "--repair-id=" + REPAIR_ID, ...baseArgs],
			{
				db: fixture.db,
				clock: () => new Date(fixture.plannedAt.getTime() + 120_000),
				resolveReleaseSha: () => RELEASE_SHA,
			}
		);
		assert.equal(rollbackDry.state, "rollback_dry_run_ready");
		await assert.rejects(
			() =>
				main(
					[
						"--rollback",
						"--apply",
						"--repair-id=" + REPAIR_ID,
						"--proof=" +
							rollbackDry.proof.replace(/[a-f0-9]$/, (value) =>
								value === "0" ? "1" : "0"
							),
						...baseArgs,
					],
					{
						db: fixture.db,
						clock: () => new Date(fixture.plannedAt.getTime() + 180_000),
						resolveReleaseSha: () => RELEASE_SHA,
					}
				),
			/proof/
		);
		const rolledBack = await main(
			[
				"--rollback",
				"--apply",
				"--repair-id=" + REPAIR_ID,
				"--proof=" + rollbackDry.proof,
				...baseArgs,
			],
			{
				db: fixture.db,
				clock: () => new Date(fixture.plannedAt.getTime() + 180_000),
				resolveReleaseSha: () => RELEASE_SHA,
			}
		);
		assert.equal(rolledBack.state, "rolled_back");
	} finally {
		console.log = originalLog;
	}
	assert.equal(
		canonicalEjsonSha256(
			await fixture.db
				.collection(COLLECTIONS.reservation)
				.findOne({ _id: oid(TARGET.reservationMongoId) })
		),
		fixture.v1Plan.expectedHash
	);
});

test("dry-run main emits only hashes and commercial values, never target PII or source text", async () => {
	const fixture = await preparedFixture();
	const messages = [];
	const originalLog = console.log;
	console.log = (value) => messages.push(String(value));
	try {
		const result = await main(
			[
				"--release-sha=" + RELEASE_SHA,
				"--portal-job-id=" + PORTAL_SELECTION.jobId,
				"--portal-job-number=" + PORTAL_SELECTION.jobNumber,
			],
			{
				db: fixture.db,
				clock: () => fixture.plannedAt,
				resolveReleaseSha: () => RELEASE_SHA,
			}
		);
		assert.equal(result.state, "dry_run_ready");
	} finally {
		console.log = originalLog;
	}
	const output = messages.join("\n");
	for (const secret of [
		TARGET.reservationMongoId,
		TARGET.pmsConfirmationNumber,
		TARGET.otaBookingId,
		TARGET.eventId,
		TARGET.mirrorId,
		PORTAL_SELECTION.jobId,
		PORTAL_SELECTION.jobNumber,
		"PRIVATE TEST GUEST",
		"PRIVATE SOURCE CONTENT",
	]) {
		assert.equal(
			output.includes(secret),
			false,
			"output leaked scoped/private data"
		);
	}
	const plan = await readyPlan(fixture);
	const sanitized = JSON.stringify(
		sanitizedForwardOutput(plan, "dry_run", proofToken(plan))
	);
	assert.equal(sanitized.includes(TARGET.otaBookingId), false);
	assert.equal(sanitized.includes(PORTAL_SELECTION.jobNumber), false);
});
