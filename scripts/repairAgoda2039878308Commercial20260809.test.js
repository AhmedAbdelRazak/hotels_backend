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
	assertExecution,
	assertMutationCapability,
	assertRelease,
	backupRecordsForPlan,
	beginManifestApply,
	createMutationCapability,
	ensureDurableBackup,
	loadPlan,
	normalizedFromAudit,
	parseArguments,
	parseProof,
	proofToken,
	protectedReservationSnapshot,
	sha256,
	verifyBackupRecords,
} = require("./repairAgoda2039878308Commercial20260809");
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

const longDate = (ymd) =>
	new Intl.DateTimeFormat("en-US", {
		month: "short",
		day: "2-digit",
		year: "numeric",
		timeZone: "UTC",
	}).format(new Date(`${ymd}T00:00:00.000Z`));

const EXECUTION = Object.freeze({
	releaseSha: RELEASE_SHA,
	treeSha: "3".repeat(40),
	executionFingerprint: "4".repeat(64),
	trackedWorktreeClean: true,
});

const executionFor = (releaseSha = RELEASE_SHA) => ({
	...EXECUTION,
	releaseSha,
	executionFingerprint:
		releaseSha === RELEASE_SHA ? EXECUTION.executionFingerprint : "5".repeat(64),
});

const agodaBody = (target) => {
	const dates = ["2026-11-04", "2026-11-05", "2026-11-06"];
	return [
		`Booking ID ${target.otaBookingId} Reservation Information`,
		"PREPAID Booking confirmation",
		"Zyd Agyad",
		`Customer First Name SAFE Customer Last Name GUEST Country of Residence Saudi Arabia Check-in ${longDate(
			target.checkinDate
		)} Check-out ${longDate(target.checkoutDate)} Other Guests [RmNo.1] [RmNo.2]`,
		`Room Type No. of Rooms Occupancy No. of Extra Bed ${target.parsedRoomName} 2 2 Adults 0`,
		`From - To Rates ${dates
			.map((date) => `${longDate(date)} SAR 121.26`)
			.join(
				" "
			)} Reference sell rate (incl. taxes & fees) SAR 588.00 Compensation Commission SAR -88.20 Agoda Growth Program SAR -58.80 Tax on Commission SAR -22.08 Targeted promotions`,
		"Net rate (incl. taxes & fees) SAR 363.78",
	].join("\n");
};

function createFixture() {
	const target = { ...TARGET };
	const directBody = agodaBody(target);
	const hotelRunnerBody = [
		`Reservation ${target.otaBookingId}`,
		`HotelRunner reservation ${target.hotelRunnerReservationId}`,
		"Agoda 2 rooms, 3 nights, payout SAR 363.78",
	].join("\n");
	target.directInboundBodyHash = sha256(directBody);
	target.directSourceTextHash = target.directInboundBodyHash;
	target.directInboundEmailHash = sha256("synthetic-direct-agoda-envelope");
	target.hotelRunnerInboundBodyHash = sha256(hotelRunnerBody);
	target.hotelRunnerInboundEmailHash = sha256(
		"synthetic-hotelrunner-relay-envelope"
	);
	target.eventPayloadHash = sha256("synthetic-hotelrunner-event-payload");
	target.eventCanonicalHash = sha256("synthetic-hotelrunner-event-canonical");
	target.eventMessageUid = sha256("event-message").slice(0, 32);

	const dates = ["2026-11-04", "2026-11-05", "2026-11-06"];
	const room = (hotelRunnerRoomId) => ({
		count: 1,
		hotelRoomConfigId: target.roomConfigId,
		localRoomConfigId: target.roomConfigId,
		hotelRunnerRoomId,
		sourceRoomName: target.projectedSourceRoomName,
		room_type: "tripleRooms",
		displayName: "Triple Room - Premium Comfort",
		totalPriceWithCommission: 181.89,
		hotelShouldGet: 267,
		chosenPrice: 60.63,
		pricingByDay: dates.map((date) => ({
			date: new Date(`${date}T00:00:00.000Z`),
			price: 60.63,
			clientPrice: 60.63,
			mainPrice: 60.63,
			totalPriceWithCommission: 60.63,
			rootPrice: 89,
			netAfterExpenses: null,
			netAfterOtaExpenses: null,
			otaExpenseAmount: null,
			platformMargin: null,
			commercialVerification: "",
			hotelRunnerSourcePrice: 60.63,
		})),
	});
	const rooms = target.hotelRunnerRoomIds.map(room);
	const reservation = {
		_id: target.reservationMongoId,
		__v: target.reservationVersion,
		hotelId: target.hotelId,
		belongsTo: target.ownerId,
		confirmation_number: target.pmsConfirmationNumber,
		reservation_id: target.otaBookingId,
		hr_number: target.hrNumber.toLowerCase(),
		otaIdentityKey: `agoda:${target.otaBookingId}`,
		otaCrossTransportIdentityKey: "",
		booking_source: "agoda",
		state: "OTA Platform Review",
		reservation_status: "OTA Platform Review",
		checkin_date: new Date("2026-11-04T00:00:00.000Z"),
		checkout_date: new Date("2026-11-07T00:00:00.000Z"),
		total_rooms: 2,
		currency: "sar",
		total_amount: 363.78,
		sub_total: 534,
		commission: 0,
		commission_ota: null,
		financeStatus: "not paid",
		payment: "",
		paid_amount: 0,
		roomId: [],
		bedNumber: [],
		pickedRoomsType: cloneBson(rooms),
		pickedRoomsPricing: cloneBson(rooms),
		customer_details: {
			confirmation_number2: target.otaBookingId,
			name: "Synthetic Guest",
			phone: "synthetic-redacted",
		},
		adminPricing: {
			mode: "hotelrunner_api",
			source: "hotelrunner_api",
			clientTotal: 363.78,
			rootTotal: 534,
			netAfterExpensesTotal: null,
			otaExpenseTotal: null,
			platformMarginTotal: null,
			commissionAmount: 0,
			defaultDeductionApplied: false,
			payoutFallbackReason: "hotelrunner_payout_not_provided",
			commercialVerified: false,
		},
		ota_financial_summary: {
			show: true,
			source: "hotelrunner_api",
			clientTotal: 363.78,
			hotelVisibleAmount: 534,
			netAfterExpenses: null,
			netAfterOtaExpenses: null,
			otaExpenseTotal: null,
			platformProfit: null,
			commissionAmount: 0,
			otaCommissionAmount: null,
			otaDeductionBreakdown: [],
			unclassifiedOtaDeduction: null,
			commercialVerified: false,
			paymentSummary: { sourceCurrency: "SAR" },
			payoutFallbackReason: "hotelrunner_payout_not_provided",
		},
		otaPlatformReview: {
			status: "pending",
			source: "hotelrunner_api",
			provider: "agoda",
			confirmationNumber: target.otaBookingId,
			hotelRunnerManaged: true,
			hotelAssignmentRequired: false,
			hotelAssignmentStatus: "assigned",
			assignedHotelId: target.hotelId,
			roomMappingStatus: "mapped",
			roomMappingHotelId: target.hotelId,
		},
		adminPricingVisibility: {
			rootOnlyForHotelManagement: true,
			source: "hotelrunner_api",
		},
		supplierData: {
			otaProvider: "agoda",
			supplierName: "agoda",
			suppliedBookingNo: target.otaBookingId,
			otaConfirmationNumber: target.otaBookingId,
			platformConfirmationNumber: target.otaBookingId,
			pmsConfirmationNumber: target.pmsConfirmationNumber,
			hotelRunner: {
				transport: "hotelrunner_api",
				reservationId: target.hotelRunnerReservationId,
				reportedPaymentMethod: "",
				pricing: {
					schemaVersion: 1,
					source: "hotelrunner_api",
					currency: "SAR",
					grandTotal: 363.78,
					hotelNetPayout: null,
					hotelNetStatus: "not_provided_by_hotelrunner",
					rooms: target.hotelRunnerRoomIds.map((roomId) => ({
						roomId,
						currency: "SAR",
						nightly: dates.map((date) => ({
							date,
							finalPrice: 60.63,
						})),
					})),
				},
			},
			otaAutomationPipeline: "hotelrunner-background-worker",
			otaSourceAuthority: 4,
			otaPaymentSummary: { sourceCurrency: "SAR" },
			otaTotalPayoutSar: null,
			otaExpenseTotalSar: null,
			otaCommissionSar: null,
			otaCommissionSource: "",
			otaCommissionSourceBacked: false,
			otaPlatformMarginSar: null,
			otaPayoutFallbackReason: "hotelrunner_payout_not_provided",
			hotelRunnerEmailCommercialEvidence: null,
			otaCommercialEvidence: null,
		},
		payment_details: { captured: false, onsite_paid_amount: 0 },
		vcc_payment: { charged: false, processing: false },
		settlement: { status: "none" },
		reviews: [{ status: "pending" }],
		reservationAuditLog: [
			{
				action: "created-by-hotelrunner",
				at: new Date("2026-08-09T15:29:46.768Z"),
			},
		],
		createdAt: new Date("2026-08-09T15:29:46.768Z"),
		updatedAt: new Date("2026-08-09T15:29:46.768Z"),
	};
	const directAudit = {
		_id: target.directInboundEmailId,
		provider: "agoda",
		intent: "new_reservation",
		eventType: "new",
		automationAction: "skipped",
		skipReason: "ota_parser_requires_manual_review",
		processingStatus: "needs_review",
		hasReservationConnection: false,
		from: '"agoda.com" <no-reply@agoda.com>',
		to: "reservations@example.invalid",
		subject: `Agoda Booking ID ${target.otaBookingId} - CONFIRMED Hotel Country: Saudi Arabia Check-in ${longDate(
			target.checkinDate
		)} / Language_English`,
		messageId: `<${target.otaBookingId}@agoda.com>`,
		bodyText: directBody,
		bodyHtml: "",
		textHash: target.directInboundBodyHash,
		emailHash: target.directInboundEmailHash,
		confirmationNumber: target.otaBookingId,
		receivedAt: new Date("2026-08-09T15:28:53.810Z"),
		processedAt: new Date("2026-08-09T15:29:04.176Z"),
		senderAuthentication: {
			authenticatedAligned: true,
			trustedProvider: "agoda",
			method: "dkim",
		},
		normalizedReservation: {
			sourceAmount: 588,
			totalPayoutSar: 363.78,
			sourceCurrency: "SAR",
			propertyCurrency: "SAR",
			exchangeRateToSar: 1,
			exchangeRateSource: "identity",
			source: {
				receivedAt: "2026-08-09T15:28:49.000Z",
				textHash: target.directSourceTextHash,
				timestampMethod: "stored_inbound_audit",
			},
			paymentSummary: {
				amountConvertedAt: "2026-08-09T15:29:04.170Z",
			},
		},
	};
	const hotelRunnerAudit = {
		_id: target.hotelRunnerInboundEmailId,
		provider: "agoda",
		bodyText: hotelRunnerBody,
		textHash: target.hotelRunnerInboundBodyHash,
		emailHash: target.hotelRunnerInboundEmailHash,
		confirmationNumber: target.otaBookingId,
		hasReservationConnection: false,
		receivedAt: new Date("2026-08-09T15:29:45.000Z"),
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
		channel: "agodaycs5",
		source: "push",
		state: "confirmed",
		status: "completed",
		messageUid: target.eventMessageUid,
		integrityConflict: false,
		integrityConflictCount: 0,
		payloadHash: target.eventPayloadHash,
		canonicalHash: target.eventCanonicalHash,
		reservationMongoId: target.reservationMongoId,
		mirrorId: target.mirrorId,
		payload: { protectedEventMarker: "immutable" },
		integrityConflicts: [],
	};
	const normalizedSnapshot = {
		totalCents: 36378,
		currency: "SAR",
		rooms: target.hotelRunnerRoomIds.map((roomId) => ({ roomId })),
	};
	target.mirrorNormalizedSnapshotHash =
		canonicalEjsonSha256(normalizedSnapshot);
	const mirror = {
		_id: target.mirrorId,
		hotelId: target.hotelId,
		hotelRunnerReservationId: target.hotelRunnerReservationId,
		hrNumber: target.hrNumber,
		hrNumberAliases: [target.hrNumber],
		providerNumber: target.otaBookingId,
		providerNumberAliases: [target.otaBookingId],
		channel: "agodaycs5",
		state: "confirmed",
		identityConflict: false,
		projectionStatus: "created",
		projectionVersion: 1,
		observedCanonicalHash: target.eventCanonicalHash,
		appliedCanonicalHash: target.eventCanonicalHash,
		reservationMongoId: target.reservationMongoId,
		normalizedSnapshot,
		lastAppliedProjection: { protectedMirrorMarker: "immutable" },
	};
	target.mirrorProjectionHash = canonicalEjsonSha256(
		mirror.lastAppliedProjection
	);
	const hotel = {
		_id: target.hotelId,
		belongsTo: target.ownerId,
		hotelName: "Zad Ajyad",
		activateHotel: true,
		xHotelProActive: true,
		currency: "sar",
		roomCountDetails: [{ _id: target.roomConfigId, activeRoom: true }],
	};

	const normalized = normalizedFromAudit(target, directAudit);
	const legacyEvidence = buildHotelRunnerEmailCommercialEvidence(normalized, {
		appliedAt: REPAIR_AT,
	});
	assert.ok(legacyEvidence);
	const commercialExisting = cloneBson(reservation);
	commercialExisting.currency = "sar";
	const commercialSet = directHotelRunnerCommercialEnrichmentSet(
		normalized,
		legacyEvidence,
		{ reportedTotalRole: "payout", existing: commercialExisting }
	);
	assert.ok(commercialSet);
	target.otaCommercialEvidenceHash =
		commercialSet["supplierData.otaCommercialEvidence"].evidenceHash;
	assert.notEqual(
		legacyEvidence.evidenceHash,
		target.otaCommercialEvidenceHash,
		"legacy and provider-neutral evidence contracts must remain independent"
	);
	target.reservationOriginalHash = canonicalEjsonSha256(reservation);
	target.eventDocumentHash = canonicalEjsonSha256(event);
	target.mirrorDocumentHash = canonicalEjsonSha256(mirror);
	target.directInboundDocumentHash = canonicalEjsonSha256(directAudit);
	target.hotelRunnerInboundDocumentHash =
		canonicalEjsonSha256(hotelRunnerAudit);

	return {
		target,
		reservation,
		event,
		mirror,
		directAudit,
		hotelRunnerAudit,
		hotel,
		legacyEvidenceHash: legacyEvidence.evidenceHash,
		commonEvidenceHash: target.otaCommercialEvidenceHash,
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
		execution: executionFor(releaseSha),
		models: harness.models,
	});
}

function capabilityFor(plan, clock = () => new Date(REPAIR_AT)) {
	const proofDetails = parseProof(proofToken(plan), new Date(REPAIR_AT));
	return createMutationCapability({
		plan,
		proofDetails,
		execution: plan.execution,
		clock,
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
test("exact two-room Agoda evidence materializes complete SAR totals only", async () => {
	const fixture = createFixture();
	const harness = createHarness(fixture);
	const normalized = normalizedFromAudit(fixture.target, fixture.directAudit);
	assert.equal(normalized.roomName, fixture.target.parsedRoomName);
	assert.equal(normalized.sourceAmount, 588);
	assert.equal(normalized.paymentSummary.sourceTotalPayoutAmount, 363.78);
	assert.equal(normalized.paymentSummary.exchangeRateSource, "identity");
	assert.equal(normalized.requiresManualReview, false);
	assert.equal(normalized.ambiguousMultiRoomEvidence, true);
	assert.equal(normalized.blocksUnmappedReservationCreation, true);
	assert.deepEqual(normalized.manualReviewReasons, [
		fixture.target.multiRoomReviewReason,
	]);
	const plan = await planFixture(fixture, harness);
	assert.equal(plan.state, "ready");
	assert.match(proofToken(plan), /^\d{13}\.[a-f0-9]{64}$/);
	assertCommercialProjection(
		fixture.target,
		plan.scope.expected,
		plan.scope.evidence
	);
	assert.equal(plan.scope.expected.currency, "sar");
	assert.equal(plan.scope.expected.total_amount, 588);
	assert.equal(plan.scope.expected.adminPricing.clientTotal, 588);
	assert.equal(plan.scope.expected.adminPricing.netAfterExpensesTotal, 363.78);
	assert.equal(plan.scope.expected.adminPricing.otaExpenseTotal, 224.22);
	assert.equal(plan.scope.expected.commission_ota, 88.2);
	assert.equal(plan.scope.expected.sub_total, 534);
	assert.equal(plan.scope.expected.adminPricing.platformMarginTotal, -170.22);
	assert.equal(plan.scope.expected.supplierData.otaProvider, "agoda");
	assert.equal(plan.scope.expected.state, "OTA Platform Review");
	assert.equal(
		plan.scope.evidence.evidenceHash,
		fixture.legacyEvidenceHash,
		"legacy evidence must be independently recomputed"
	);
	assert.equal(
		plan.scope.expected.supplierData.otaCommercialEvidence.evidenceHash,
		fixture.commonEvidenceHash,
		"provider-neutral evidence must be independently recomputed"
	);
	assert.notEqual(fixture.legacyEvidenceHash, fixture.commonEvidenceHash);
	assert.deepEqual(
		plan.scope.expected.payment_details,
		fixture.reservation.payment_details
	);
	assert.deepEqual(plan.scope.expected.vcc_payment, fixture.reservation.vcc_payment);
	assert.deepEqual(plan.scope.expected.settlement, fixture.reservation.settlement);
	assert.deepEqual(plan.scope.expected.reviews, fixture.reservation.reviews);
	assert.deepEqual(
		plan.scope.expected.reservationAuditLog.slice(0, -1),
		fixture.reservation.reservationAuditLog
	);
	assert.equal(
		plan.scope.expected.reservationAuditLog.at(-1).repairId,
		REPAIR_ID
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

test("SAR identity and the sole exact multi-room waiver fail closed on drift", () => {
	const fixture = createFixture();
	const normalized = normalizedFromAudit(fixture.target, fixture.directAudit);
	assert.equal(normalized.exchangeRateToSar, 1);
	const wrongPair = cloneBson(fixture.directAudit);
	wrongPair.normalizedReservation.propertyCurrency = "AED";
	assert.throws(
		() => normalizedFromAudit(fixture.target, wrongPair),
		/SAR identity-conversion evidence changed/
	);
	const changedGross = cloneBson(fixture.directAudit);
	changedGross.bodyText = changedGross.bodyText.replace("588.00", "589.00");
	changedGross.textHash = sha256(changedGross.bodyText);
	changedGross.normalizedReservation.source.textHash = changedGross.textHash;
	assert.throws(
		() => normalizedFromAudit(fixture.target, changedGross),
		/exact authenticated Agoda facts/
	);
	const secondConflict = { ...fixture.target, multiRoomReviewReason: "wrong" };
	assert.throws(
		() => normalizedFromAudit(secondConflict, fixture.directAudit),
		/sole multi-room review/
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
			"direct_agoda_email_evidence",
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

test("missing, forged, expired, or mismatched capabilities cannot write", async () => {
	const fixture = createFixture();
	const harness = createHarness(fixture);
	const plan = await planFixture(fixture, harness);
	for (const capability of [undefined, {}, { ...capabilityFor(plan) }]) {
		await assert.rejects(
			() =>
				applyPlan(plan, {
					db: harness.db,
					models: harness.models,
					capability,
				}),
			(error) =>
				error?.code === "AGODA_2039878308_REPAIR_WRITE_UNAUTHORIZED"
		);
	}
	const expired = capabilityFor(
		plan,
		() => new Date(REPAIR_AT.getTime() + 31 * 60_000)
	);
	await assert.rejects(
		() =>
			applyPlan(plan, {
				db: harness.db,
				models: harness.models,
				capability: expired,
			}),
		(error) => error?.code === "AGODA_2039878308_REPAIR_PROOF_EXPIRED"
	);
	assert.equal(harness.documents.backups.length, 0);
	assert.equal(harness.documents.manifests.length, 0);
	assert.equal(harness.ReservationCollection.stats.replaceCalls, 0);
	assert.throws(
		() =>
			assertMutationCapability(capabilityFor(plan), {
				...plan,
				planHash: "f".repeat(64),
			}),
		/authorized/
	);
});

test("the applying manifest has one execution owner", async () => {
	const fixture = createFixture();
	const harness = createHarness(fixture);
	const plan = await planFixture(fixture, harness);
	const capability = capabilityFor(plan);
	const backup = await ensureDurableBackup(plan, harness.db, { capability });
	const firstOwner = "a".repeat(64);
	const secondOwner = "b".repeat(64);
	const applying = await beginManifestApply(
		harness.db,
		backup.manifest,
		plan,
		firstOwner,
		capability
	);
	assert.equal(applying.applyOwnerToken, firstOwner);
	await assert.rejects(
		() =>
			beginManifestApply(
				harness.db,
				backup.manifest,
				plan,
				secondOwner,
				capability
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
	const capability = capabilityFor(plan);
	const result = await applyPlan(plan, {
		db: harness.db,
		models: harness.models,
		capability,
	});
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
	let clockCalls = 0;
	const capability = capabilityFor(plan, () => {
		clockCalls += 1;
		return clockCalls <= 2
			? new Date(REPAIR_AT)
			: new Date(REPAIR_AT.getTime() + 31 * 60_000);
	});
	await assert.rejects(
		async () => {
			try {
				await applyPlan(plan, {
					db: harness.db,
					models: harness.models,
					capability,
				});
			} catch (error) {
				assert.equal(error.compensated, true);
				throw error;
			}
		},
		/Exact Agoda scope must be one reservation/
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
	const capability = capabilityFor(plan);
	await assert.rejects(
		() =>
			applyPlan(plan, {
				db: harness.db,
				models: harness.models,
				capability,
			}),
		(error) =>
			error?.code ===
			"AGODA_2039878308_REPAIR_MANUAL_INTERVENTION_REQUIRED"
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
