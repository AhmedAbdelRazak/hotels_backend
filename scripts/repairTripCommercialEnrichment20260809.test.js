/** @format */

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
	BACKUP_COLLECTION,
	MANIFEST_COLLECTION,
	REPAIR_ID,
	TARGET,
	applyPlan,
	assertCommercialProjection,
	assertRelease,
	backupRecordsForPlan,
	beginManifestApply,
	ensureDurableBackup,
	loadPlan,
	normalizedFromAudit,
	parseArguments,
	parseProof,
	proofToken,
	protectedReservationSnapshot,
	sha256,
	trustedExchangeEvidence,
	verifyBackupRecords,
} = require("./repairTripCommercialEnrichment20260809");
const {
	buildHotelRunnerEmailCommercialEvidence,
	directHotelRunnerCommercialEnrichmentSet,
} = require("../services/otaReservationMapper");
const {
	canonicalEjsonSha256,
	cloneBson,
} = require("../services/recentOtaInboundRecovery20260805");

const RELEASE_SHA = "1".repeat(40);
const OTHER_RELEASE_SHA = "2".repeat(40);
const REPAIR_AT = new Date("2026-08-09T06:00:00.000Z");

const tripBody = (bookingId) =>
	[
		`Booking no. # ${bookingId} #`,
		"Zad Ajyad Hotel",
		"Guest Name:",
		"Synthetic Guest",
		"Staying period: Aug 10, 2026 - Aug 11, 2026 | 1 night",
		"Room Type:Comfort Quadruple Room - Zad Ajyad Hotel - Bus to Haram",
		"Flexible-before the day of arrival-Room Only-Prepay | 1 room(s)AllotmentBed",
		"Room Type: Comfort Quadruple Room - Zad Ajyad Hotel - Bus to Haram Flexible-before the day of arrival-Room Only-Prepay | 1 room(s) Allotment",
		"Guests (estimated): 4 adults, 0 children",
		"Payment information",
		"Net rate | Prepaid | monthly settlement",
		"Room rate 1 room(s) x 1 night(s)",
		"Final room rate (incl. taxes and fees) USD 16.83",
		"Your payout USD 15.89",
		"This is a prepaid reservation. The guest has already paid for the room.",
		"Room ratePrice details",
	].join("\n");

function createFixture() {
	const target = { ...TARGET };
	const sourceReceivedAt = "2026-08-09T05:47:21.899Z";
	const convertedAt = "2026-08-09T05:45:00.000Z";
	const processedAt = "2026-08-09T05:48:00.000Z";
	const directBody = tripBody(target.otaBookingId);
	const hotelRunnerBody = [
		`Reservation ${target.otaBookingId}`,
		`HotelRunner reservation ${target.hotelRunnerReservationId}`,
		"Commercial source amount USD 15.89",
	].join("\n");
	target.directInboundBodyHash = sha256(directBody);
	target.directInboundEmailHash = sha256("synthetic-direct-trip-envelope");
	target.directSourceTextHash = sha256("synthetic-normalized-trip-source");
	target.hotelRunnerInboundBodyHash = sha256(hotelRunnerBody);
	target.hotelRunnerInboundEmailHash = sha256(
		"synthetic-hotelrunner-envelope"
	);
	target.eventPayloadHash = sha256("synthetic-hotelrunner-event-payload");
	target.eventCanonicalHash = sha256("synthetic-hotelrunner-event-canonical");
	const exchangeTuple = {
		provider: "exchange_rate_api",
		sourceType: "trusted_exchange_evidence",
		sourceCurrency: "USD",
		propertyCurrency: "SAR",
		rate: 3.75,
		sourceTimestamp: target.conversionSourceTimestamp,
	};
	target.conversionSourceHash = sha256(JSON.stringify(exchangeTuple));
	target.conversionSourceId = `exchange-rate-api-usd-sar-${target.conversionSourceHash.slice(
		0,
		24
	)}`;

	const initialDay = {
		date: new Date("2026-08-10T00:00:00.000Z"),
		price: 15.89,
		clientPrice: 15.89,
		mainPrice: 15.89,
		totalPriceWithCommission: 15.89,
		rootPrice: 75,
		netAfterExpenses: null,
		netAfterOtaExpenses: null,
		otaExpenseAmount: null,
		platformMargin: null,
		commercialVerification: "",
		hotelRunnerSourcePrice: 15.89,
		protectedAvailabilityMarker: "unchanged",
	};
	const initialRoom = {
		count: 1,
		hotelRoomConfigId: target.roomConfigId,
		localRoomConfigId: target.roomConfigId,
		sourceRoomName: target.projectedSourceRoomName,
		room_type: "Synthetic Quadruple",
		totalPriceWithCommission: 15.89,
		hotelShouldGet: 75,
		chosenPrice: 15.89,
		pricingByDay: [initialDay],
		protectedRoomMarker: { inventory: 4 },
	};
	const reservation = {
		_id: target.reservationMongoId,
		__v: target.reservationVersion,
		hotelId: target.hotelId,
		belongsTo: target.ownerId,
		confirmation_number: target.pmsConfirmationNumber,
		reservation_id: target.otaBookingId,
		otaIdentityKey: `hotelrunner:${target.otaBookingId}`,
		otaCrossTransportIdentityKey: `trip:${target.otaBookingId}`,
		state: "OTA Platform Review",
		reservation_status: "OTA Platform Review",
		checkin_date: new Date("2026-08-10T00:00:00.000Z"),
		checkout_date: new Date("2026-08-11T00:00:00.000Z"),
		total_rooms: 1,
		currency: "usd",
		total_amount: 15.89,
		sub_total: 75,
		commission: 0,
		commission_ota: null,
		pickedRoomsType: [cloneBson(initialRoom)],
		pickedRoomsPricing: [cloneBson(initialRoom)],
		customer_details: {
			confirmation_number2: target.otaBookingId,
			name: "Synthetic Guest",
			phone: "synthetic-redacted",
		},
		adminPricing: {
			mode: "hotelrunner_api",
			source: "hotelrunner",
			clientTotal: 15.89,
			rootTotal: 75,
			netAfterExpensesTotal: null,
			otaExpenseTotal: null,
			platformMarginTotal: null,
			commissionAmount: 0,
			defaultDeductionApplied: false,
			payoutFallbackReason: "commercial role unresolved",
			commercialVerified: false,
		},
		ota_financial_summary: {
			show: true,
			source: "hotelrunner",
			clientTotal: 15.89,
			hotelVisibleAmount: 75,
			netAfterExpenses: null,
			netAfterOtaExpenses: null,
			otaExpenseTotal: null,
			platformProfit: null,
			commissionAmount: 0,
			otaCommissionAmount: null,
			otaDeductionBreakdown: [],
			unclassifiedOtaDeduction: null,
			commercialVerified: false,
			paymentSummary: { sourceCurrency: "USD" },
			payoutFallbackReason: "commercial role unresolved",
		},
		supplierData: {
			otaProvider: "hotelrunner",
			supplierName: "Trip.com",
			suppliedBookingNo: target.otaBookingId,
			otaConfirmationNumber: target.otaBookingId,
			platformConfirmationNumber: target.otaBookingId,
			pmsConfirmationNumber: target.pmsConfirmationNumber,
			hotelRunner: {
				transport: "api",
				reservationId: target.hotelRunnerReservationId,
			},
			otaSourceAuthority: {
				lifecycle: "hotelrunner",
				commercial: "unresolved",
			},
			otaPaymentSummary: { sourceCurrency: "USD" },
			otaTotalPayoutSar: null,
			otaExpenseTotalSar: null,
			otaCommissionSar: null,
			otaCommissionSource: "",
			otaCommissionSourceBacked: false,
			otaPlatformMarginSar: null,
			otaPayoutFallbackReason: "commercial role unresolved",
			hotelRunnerEmailCommercialEvidence: null,
			otaCommercialEvidence: null,
			protectedSupplierMarker: "keep-provider-and-lifecycle",
		},
		payment_details: {
			captured: false,
			status: "unresolved",
			protectedPaymentMarker: "unchanged",
		},
		vcc_payment: {
			charged: false,
			attempts: [],
			protectedVccMarker: "unchanged",
		},
		settlement: { status: "none", protectedSettlementMarker: "unchanged" },
		reviews: [{ status: "pending", protectedReviewMarker: "unchanged" }],
		reservationAuditLog: [
			{
				action: "created-by-hotelrunner",
				at: new Date("2026-08-09T05:50:00.000Z"),
			},
		],
		createdAt: new Date("2026-08-09T05:50:00.000Z"),
		updatedAt: new Date("2026-08-09T05:50:00.000Z"),
	};
	const directAudit = {
		_id: target.directInboundEmailId,
		provider: "trip",
		from: "Trip.com <ebooking@trip.com>",
		to: "ota@example.invalid",
		subject: `New Booking no. # ${target.otaBookingId} #`,
		messageId: `trip-${target.otaBookingId}@mail.trip.com`,
		bodyText: directBody,
		bodyHtml: "",
		textHash: target.directInboundBodyHash,
		emailHash: target.directInboundEmailHash,
		confirmationNumber: target.otaBookingId,
		receivedAt: new Date(sourceReceivedAt),
		processedAt: new Date(processedAt),
		senderAuthentication: {
			authenticatedAligned: true,
			trustedProvider: "trip",
			method: "dkim",
		},
		normalizedReservation: {
			sourceAmount: 16.83,
			sourcePayoutAmount: 15.89,
			sourceCurrency: "USD",
			sourcePayoutCurrency: "USD",
			source: {
				receivedAt: sourceReceivedAt,
				textHash: target.directSourceTextHash,
				timestampMethod: "stored_inbound_audit",
			},
			currencyConversionEvidence: {
				trusted: true,
				verified: true,
				sourceCurrency: "USD",
				propertyCurrency: "SAR",
				rate: 3.75,
				provenance: {
					provider: exchangeTuple.provider,
					sourceType: exchangeTuple.sourceType,
					sourceHash: target.conversionSourceHash,
					sourceTimestamp: target.conversionSourceTimestamp,
					sourceId: target.conversionSourceId,
				},
			},
			paymentSummary: { amountConvertedAt: convertedAt },
		},
	};
	const hotelRunnerAudit = {
		_id: target.hotelRunnerInboundEmailId,
		provider: "hotelrunner",
		bodyText: hotelRunnerBody,
		textHash: target.hotelRunnerInboundBodyHash,
		emailHash: target.hotelRunnerInboundEmailHash,
		confirmationNumber: target.otaBookingId,
		reservationMongoId: target.reservationMongoId,
		pmsConfirmationNumber: target.pmsConfirmationNumber,
		receivedAt: new Date("2026-08-09T05:51:00.000Z"),
		senderAuthentication: {
			authenticatedAligned: true,
			trustedProvider: "hotelrunner",
			method: "dkim",
		},
	};
	const event = {
		_id: target.eventId,
		hotelId: target.hotelId,
		hotelRunnerReservationId: target.hotelRunnerReservationId,
		hrNumber: target.hrNumber,
		providerNumber: target.otaBookingId,
		channel: "tripcom",
		state: "confirmed",
		status: "completed",
		integrityConflict: false,
		integrityConflictCount: 0,
		payloadHash: target.eventPayloadHash,
		canonicalHash: target.eventCanonicalHash,
		reservationMongoId: target.reservationMongoId,
		mirrorId: target.mirrorId,
		payload: { protectedEventMarker: "immutable" },
	};
	const mirror = {
		_id: target.mirrorId,
		hotelId: target.hotelId,
		hotelRunnerReservationId: target.hotelRunnerReservationId,
		hrNumber: target.hrNumber,
		hrNumberAliases: [target.hrNumber],
		providerNumber: target.otaBookingId,
		providerNumberAliases: [target.otaBookingId],
		channel: "tripcom",
		state: "confirmed",
		identityConflict: false,
		projectionStatus: "updated",
		reservationMongoId: target.reservationMongoId,
		normalizedSnapshot: { totalCents: 1589, currency: "USD" },
		lastAppliedProjection: { protectedMirrorMarker: "immutable" },
	};
	const hotel = {
		_id: target.hotelId,
		belongsTo: target.ownerId,
		hotelName: "Zad Ajyad",
		activateHotel: true,
		xHotelProActive: true,
		roomCountDetails: [{ _id: target.roomConfigId, activeRoom: true }],
	};

	const normalized = normalizedFromAudit(target, directAudit);
	const emailEvidence = buildHotelRunnerEmailCommercialEvidence(normalized, {
		appliedAt: REPAIR_AT,
	});
	assert.ok(emailEvidence);
	target.emailCommercialEvidenceHash = emailEvidence.evidenceHash;
	const commercialExisting = cloneBson(reservation);
	commercialExisting.currency = "sar";
	const commercialSet = directHotelRunnerCommercialEnrichmentSet(
		normalized,
		emailEvidence,
		{ reportedTotalRole: "unknown", existing: commercialExisting }
	);
	assert.ok(commercialSet);
	target.otaCommercialEvidenceHash =
		commercialSet["supplierData.otaCommercialEvidence"].evidenceHash;
	target.reservationOriginalHash = canonicalEjsonSha256(reservation);
	target.eventDocumentHash = canonicalEjsonSha256(event);
	target.mirrorDocumentHash = canonicalEjsonSha256(mirror);
	target.directInboundDocumentHash = canonicalEjsonSha256(directAudit);
	target.hotelRunnerInboundDocumentHash = canonicalEjsonSha256(hotelRunnerAudit);

	return {
		target,
		reservation,
		event,
		mirror,
		directAudit,
		hotelRunnerAudit,
		hotel,
	};
}

function valueAt(document, pathText) {
	return pathText.split(".").reduce((value, key) => value?.[key], document);
}

function sameScalar(left, right) {
	if (left instanceof Date || right instanceof Date) {
		return new Date(left).getTime() === new Date(right).getTime();
	}
	if (left && right && typeof left === "object" && typeof right === "object") {
		return canonicalEjsonSha256(left) === canonicalEjsonSha256(right);
	}
	return String(left) === String(right);
}

function matches(document, filter = {}) {
	if (Array.isArray(filter.$and) && !filter.$and.every((part) => matches(document, part))) {
		return false;
	}
	if (Array.isArray(filter.$or) && !filter.$or.some((part) => matches(document, part))) {
		return false;
	}
	for (const [key, expected] of Object.entries(filter)) {
		if (key === "$and" || key === "$or" || key === "$expr") continue;
		const actual = valueAt(document, key);
		if (expected && typeof expected === "object" && Array.isArray(expected.$in)) {
			if (!expected.$in.some((value) => sameScalar(actual, value))) return false;
			continue;
		}
		if (!sameScalar(actual, expected)) return false;
	}
	return true;
}

function createModel(documents, { onExec = null } = {}) {
	const stats = { findCalls: 0 };
	return {
		stats,
		find(filter) {
			let limit = Infinity;
			const query = {
				select() {
					return query;
				},
				limit(value) {
					limit = value;
					return query;
				},
				read() {
					return query;
				},
				readConcern() {
					return query;
				},
				lean() {
					return query;
				},
				async exec() {
					stats.findCalls += 1;
					let rows = documents.filter((document) => matches(document, filter));
					if (onExec) {
						rows = onExec({
							call: stats.findCalls,
							rows,
							filter,
							documents,
						});
					}
					return rows.slice(0, limit).map(cloneBson);
				},
			};
			return query;
		},
	};
}

function createReservationCollection(documents, { onAfterReplace = null } = {}) {
	const stats = { replaceCalls: 0 };
	return {
		stats,
		async findOne(filter) {
			const found = documents.find((document) => matches(document, filter));
			return found ? cloneBson(found) : null;
		},
		async replaceOne(filter, replacement) {
			stats.replaceCalls += 1;
			const exactBefore = Array.isArray(filter?.$and) ? filter.$and[0] : null;
			const index = documents.findIndex((document) =>
				exactBefore
					? canonicalEjsonSha256(document) === canonicalEjsonSha256(exactBefore)
					: matches(document, filter)
			);
			if (index < 0) {
				return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
			}
			documents[index] = cloneBson(replacement);
			if (onAfterReplace) {
				onAfterReplace({
					call: stats.replaceCalls,
					documents,
					index,
					replacement,
				});
			}
			return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
		},
	};
}

function createArtifactCollection(documents) {
	return {
		async findOne(filter) {
			const found = documents.find((document) => matches(document, filter));
			return found ? cloneBson(found) : null;
		},
		async insertOne(document) {
			if (documents.some((item) => sameScalar(item._id, document._id))) {
				throw new Error("duplicate artifact");
			}
			documents.push(cloneBson(document));
			return { acknowledged: true, insertedId: document._id };
		},
		find(filter) {
			let sortSpec = null;
			return {
				sort(spec) {
					sortSpec = spec;
					return this;
				},
				async toArray() {
					const rows = documents.filter((document) => matches(document, filter));
					if (sortSpec?.role) {
						rows.sort((left, right) =>
							String(left.role).localeCompare(String(right.role))
						);
					}
					return rows.map(cloneBson);
				},
			};
		},
		async updateOne(filter, update) {
			const index = documents.findIndex((document) => matches(document, filter));
			if (index < 0) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
			if (update.$set) Object.assign(documents[index], cloneBson(update.$set));
			return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
		},
	};
}

function createHarness(
	fixture,
	{ reservationOnExec = null, onAfterReplace = null } = {}
) {
	const documents = {
		reservations: [cloneBson(fixture.reservation)],
		events: [cloneBson(fixture.event)],
		mirrors: [cloneBson(fixture.mirror)],
		audits: [cloneBson(fixture.directAudit), cloneBson(fixture.hotelRunnerAudit)],
		hotels: [cloneBson(fixture.hotel)],
		backups: [],
		manifests: [],
	};
	const ReservationCollection = createReservationCollection(
		documents.reservations,
		{ onAfterReplace }
	);
	const collections = {
		[BACKUP_COLLECTION]: createArtifactCollection(documents.backups),
		[MANIFEST_COLLECTION]: createArtifactCollection(documents.manifests),
	};
	const db = {
		collection(name) {
			if (!collections[name]) throw new Error(`unexpected collection ${name}`);
			return collections[name];
		},
	};
	const models = {
		skipConnect: true,
		target: fixture.target,
		ReservationModel: createModel(documents.reservations, {
			onExec: reservationOnExec,
		}),
		ReservationCollection,
		EventModel: createModel(documents.events),
		MirrorModel: createModel(documents.mirrors),
		InboundModel: createModel(documents.audits),
		HotelModel: createModel(documents.hotels),
	};
	return { db, models, documents, ReservationCollection };
}

async function planFixture(fixture, harness, releaseSha = RELEASE_SHA) {
	return loadPlan({
		target: fixture.target,
		repairAt: REPAIR_AT,
		releaseSha,
		models: harness.models,
	});
}

test("arguments, proof freshness, and release binding fail closed", () => {
	assert.deepEqual(parseArguments([`--release-sha=${RELEASE_SHA}`]), {
		apply: false,
		repairId: "",
		releaseSha: RELEASE_SHA,
		proof: "",
	});
	const proof = `${REPAIR_AT.getTime()}.${"a".repeat(64)}`;
	assert.equal(
		parseProof(proof, new Date(REPAIR_AT.getTime() + 60_000)).planHash,
		"a".repeat(64)
	);
	assert.throws(
		() => parseProof(proof, new Date(REPAIR_AT.getTime() + 31 * 60_000)),
		/expired or from the future/
	);
	assert.throws(
		() =>
			parseArguments([
				"--apply",
				`--repair-id=${REPAIR_ID}`,
				`--release-sha=${RELEASE_SHA}`,
			]),
		/exact unexpired dry-run proof/
	);
	assert.throws(
		() =>
			parseArguments([
				"--apply",
				`--repair-id=${REPAIR_ID}-wrong`,
				`--release-sha=${RELEASE_SHA}`,
				`--proof=${proof}`,
			]),
		/Apply requires/
	);
	assert.doesNotThrow(() => assertRelease(RELEASE_SHA, RELEASE_SHA));
	assert.throws(() => assertRelease(RELEASE_SHA, OTHER_RELEASE_SHA), /approved merge SHA/);
});

test("wrapped Trip evidence produces only the exact SAR commercial projection", async () => {
	const fixture = createFixture();
	const harness = createHarness(fixture);
	const normalized = normalizedFromAudit(fixture.target, fixture.directAudit);
	assert.equal(normalized.roomName, fixture.target.parsedRoomName);
	assert.equal(normalized.sourceAmount, 16.83);
	assert.equal(normalized.paymentSummary.sourceTotalPayoutAmount, 15.89);
	assert.equal(normalized.paymentSummary.exchangeRateSource, "exchange_rate_api");
	const plan = await planFixture(fixture, harness);
	assert.equal(plan.state, "ready");
	assert.match(proofToken(plan), /^\d{13}\.[a-f0-9]{64}$/);
	assertCommercialProjection(fixture.target, plan.scope.expected, plan.scope.evidence);
	assert.equal(plan.scope.expected.currency, "sar");
	assert.equal(plan.scope.expected.total_amount, 63.11);
	assert.equal(plan.scope.expected.adminPricing.netAfterExpensesTotal, 59.59);
	assert.equal(plan.scope.expected.adminPricing.otaExpenseTotal, 3.52);
	assert.equal(plan.scope.expected.commission_ota, null);
	assert.equal(plan.scope.expected.sub_total, 75);
	assert.equal(plan.scope.expected.adminPricing.platformMarginTotal, -15.41);
	assert.equal(plan.scope.expected.supplierData.otaProvider, "hotelrunner");
	assert.equal(plan.scope.expected.state, "OTA Platform Review");
	assert.deepEqual(plan.scope.expected.payment_details, fixture.reservation.payment_details);
	assert.deepEqual(plan.scope.expected.vcc_payment, fixture.reservation.vcc_payment);
	assert.deepEqual(plan.scope.expected.settlement, fixture.reservation.settlement);
	assert.deepEqual(plan.scope.expected.reviews, fixture.reservation.reviews);
	assert.deepEqual(
		plan.scope.expected.reservationAuditLog,
		fixture.reservation.reservationAuditLog
	);
	assert.equal(
		canonicalEjsonSha256(protectedReservationSnapshot(plan.scope.expected)),
		canonicalEjsonSha256(protectedReservationSnapshot(fixture.reservation))
	);
	const otherReleasePlan = await planFixture(
		fixture,
		createHarness(fixture),
		OTHER_RELEASE_SHA
	);
	assert.notEqual(otherReleasePlan.planHash, plan.planHash);
});

test("stored exchange evidence validates pair, hash, source ID, and freshness", () => {
	const fixture = createFixture();
	const valid = trustedExchangeEvidence(fixture.target, fixture.directAudit);
	assert.equal(valid.rate, 3.75);
	assert.equal(valid.provenance.sourceHash, fixture.target.conversionSourceHash);
	const wrongId = cloneBson(fixture.directAudit);
	wrongId.normalizedReservation.currencyConversionEvidence.provenance.sourceId =
		"exchange-rate-api-usd-sar-wrong";
	assert.throws(
		() => trustedExchangeEvidence(fixture.target, wrongId),
		/hash, source ID, rate/
	);
	const stale = cloneBson(fixture.directAudit);
	stale.normalizedReservation.paymentSummary.amountConvertedAt =
		"2026-08-17T05:45:00.000Z";
	stale.processedAt = new Date("2026-08-17T05:46:00.000Z");
	assert.throws(
		() => trustedExchangeEvidence(fixture.target, stale),
		/absent, stale, future-dated, or pair-invalid/
	);
	const wrongPair = cloneBson(fixture.directAudit);
	wrongPair.normalizedReservation.currencyConversionEvidence.propertyCurrency = "AED";
	assert.throws(
		() => trustedExchangeEvidence(fixture.target, wrongPair),
		/pair-invalid/
	);
});

test("scope hashes and exact-one identity counts reject drift and duplicates", async () => {
	const fixture = createFixture();
	const tamperedHarness = createHarness(fixture);
	tamperedHarness.documents.audits[0].subject = "tampered immutable subject";
	await assert.rejects(
		() => planFixture(fixture, tamperedHarness),
		/full-document hash changed/
	);
	const duplicateHarness = createHarness(fixture);
	const duplicate = cloneBson(fixture.event);
	duplicate._id = "synthetic-duplicate-event";
	duplicateHarness.documents.events.push(duplicate);
	await assert.rejects(
		() => planFixture(fixture, duplicateHarness),
		/one reservation\/event\/mirror; found 1\/2\/1/
	);
	const crossHotelHarness = createHarness(fixture);
	const duplicateReservation = cloneBson(fixture.reservation);
	duplicateReservation._id = "synthetic-cross-hotel-duplicate";
	duplicateReservation.hotelId = "synthetic-other-hotel";
	crossHotelHarness.documents.reservations.push(duplicateReservation);
	await assert.rejects(
		() => planFixture(fixture, crossHotelHarness),
		/one reservation\/event\/mirror; found 2\/1\/1/
	);
});

test("five full-document backups and manifest bindings reject any tamper", async () => {
	const fixture = createFixture();
	const plan = await planFixture(fixture, createHarness(fixture));
	const records = backupRecordsForPlan(plan);
	assert.equal(records.length, 5);
	assert.deepEqual(
		new Set(records.map((record) => record.role)),
		new Set([
			"reservation_before",
			"hotelrunner_event_evidence",
			"hotelrunner_mirror_evidence",
			"direct_trip_email_evidence",
			"hotelrunner_email_evidence",
		])
	);
	assert.doesNotThrow(() => verifyBackupRecords(records, null, fixture.target));
	const tampered = cloneBson(records);
	tampered[0].originalDocument.customer_details.name = "tampered";
	assert.throws(
		() => verifyBackupRecords(tampered, null, fixture.target),
		/failed integrity/
	);
});

test("the applying manifest has one execution owner", async () => {
	const fixture = createFixture();
	const harness = createHarness(fixture);
	const plan = await planFixture(fixture, harness);
	const backup = await ensureDurableBackup(plan, harness.db);
	const firstOwner = "a".repeat(64);
	const secondOwner = "b".repeat(64);
	const applying = await beginManifestApply(
		harness.db,
		backup.manifest,
		plan,
		firstOwner
	);
	assert.equal(applying.applyOwnerToken, firstOwner);
	await assert.rejects(
		() =>
			beginManifestApply(
				harness.db,
				backup.manifest,
				plan,
				secondOwner
			),
		/applying-state CAS was rejected/
	);
});

test("apply is one exact CAS, permanently backed up, and idempotent", async () => {
	const fixture = createFixture();
	const harness = createHarness(fixture);
	const immutableHashes = {
		event: canonicalEjsonSha256(harness.documents.events[0]),
		mirror: canonicalEjsonSha256(harness.documents.mirrors[0]),
		audits: harness.documents.audits.map(canonicalEjsonSha256),
	};
	const plan = await planFixture(fixture, harness);
	const result = await applyPlan(plan, { db: harness.db, models: harness.models });
	assert.equal(result.state, "applied");
	assert.equal(result.changed, 1);
	assert.equal(result.vendorApiCalls, 0);
	assert.equal(harness.ReservationCollection.stats.replaceCalls, 1);
	assert.equal(
		canonicalEjsonSha256(harness.documents.reservations[0]),
		plan.scope.expectedHash
	);
	assert.equal(harness.documents.backups.length, 5);
	assert.equal(harness.documents.manifests.length, 1);
	assert.equal(harness.documents.manifests[0].state, "applied");
	assert.equal(
		harness.documents.manifests[0].appliedDocumentHash,
		plan.scope.expectedHash
	);
	assert.equal(canonicalEjsonSha256(harness.documents.events[0]), immutableHashes.event);
	assert.equal(canonicalEjsonSha256(harness.documents.mirrors[0]), immutableHashes.mirror);
	assert.deepEqual(
		harness.documents.audits.map(canonicalEjsonSha256),
		immutableHashes.audits
	);
	const rerunPlan = await planFixture(fixture, harness);
	assert.equal(rerunPlan.state, "already_applied");
	const rerun = await applyPlan(rerunPlan, {
		db: harness.db,
		models: harness.models,
	});
	assert.equal(rerun.state, "already_applied");
	assert.equal(rerun.changed, 0);
	assert.equal(harness.ReservationCollection.stats.replaceCalls, 1);
});

test("standalone apply compensates expected back to the exact original on postverify failure", async () => {
	const fixture = createFixture();
	const harness = createHarness(fixture, {
		reservationOnExec({ call, rows }) {
			return call === 3 ? [] : rows;
		},
	});
	const plan = await planFixture(fixture, harness);
	await assert.rejects(
		async () => {
			try {
				await applyPlan(plan, { db: harness.db, models: harness.models });
			} catch (error) {
				assert.equal(error.compensated, true);
				throw error;
			}
		},
		/Exact Trip scope must be one reservation/
	);
	assert.equal(harness.ReservationCollection.stats.replaceCalls, 2);
	assert.equal(
		canonicalEjsonSha256(harness.documents.reservations[0]),
		plan.scope.originalHash
	);
	assert.equal(harness.documents.manifests[0].state, "backed_up");
	assert.equal(
		harness.documents.manifests[0].compensationDocumentHash,
		plan.scope.originalHash
	);
	assert.equal(harness.documents.manifests[0].compensationWritePerformed, true);
});

test("compensation never overwrites a foreign concurrent reservation", async () => {
	const fixture = createFixture();
	const harness = createHarness(fixture, {
		onAfterReplace({ call, documents, index }) {
			if (call === 1) documents[index].concurrentTerminalWrite = "preserved";
		},
	});
	const plan = await planFixture(fixture, harness);
	await assert.rejects(
		() => applyPlan(plan, { db: harness.db, models: harness.models }),
		(error) => error?.code === "TRIP_REPAIR_MANUAL_INTERVENTION_REQUIRED"
	);
	assert.equal(harness.ReservationCollection.stats.replaceCalls, 1);
	assert.equal(
		harness.documents.reservations[0].concurrentTerminalWrite,
		"preserved"
	);
	assert.equal(
		harness.documents.manifests[0].state,
		"manual_intervention_required"
	);
});
