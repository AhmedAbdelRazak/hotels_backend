/** @format */

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const mongoose = require("mongoose");

const {
	AWAITING_MESSAGE,
	BACKUP_COLLECTION,
	JOB_HOLD_MS,
	REPAIR_ID,
	SCOPE_ATTESTATION,
	TARGET,
	WORKER_UNIT,
	applyRecovery,
	applyUpdateToDocument,
	assertStandaloneWritablePrimary,
	backupRecord,
	buildPlan,
	cloneFullBson,
	parseArguments,
	parseProof,
	proofToken,
	validateReleaseAttestation,
	validateScope,
	validateWorkerUnitState,
	verifyBackup,
} = require("./recoverAgoda2040450395Commercial20260811");
const {
	canonicalEjsonSha256,
} = require("../services/tripHotelRunnerRepair20260805");
const {
	createArchiveFingerprint,
} = require("../services/hotelrunnerFirstOtaFallback");
const {
	buildHotelRunnerUnresolvedCommercialEvidence,
} = require("../services/otaCommercialEvidence");

const RELEASE = "a".repeat(40);
const TREE = "b".repeat(40);
const PLANNED_AT = new Date("2026-08-11T19:00:00.000Z");
const APPLY_AT = new Date("2026-08-11T19:00:01.000Z");
const OWNER_TOKEN = "c".repeat(64);
const oid = (value) => new mongoose.Types.ObjectId(value);
const sha = (character) => character.repeat(64);
const commercialSummary = () => ({
	reportedTotalRole: "payout",
	hotelRunnerReportedAmount: TARGET.hotelRunnerReportedAmount,
	rootTotal: TARGET.rootTotal,
	guestGross: TARGET.guestGross,
	hotelPayout: TARGET.hotelPayout,
	otaExpense: TARGET.otaExpense,
	platformMargin: TARGET.platformMargin,
	otaCommission: TARGET.otaCommission,
	paidAmount: TARGET.guestGross,
});
const commercialPreflight = () => commercialSummary();

function fixtureScope() {
	const normalizedReservation = {
		provider: TARGET.provider,
		confirmationNumber: TARGET.confirmationNumber,
		reservationId: TARGET.confirmationNumber,
		intent: "new_reservation",
		eventType: "new",
		sourceSenderTrusted: true,
		sourceSenderAuthenticated: true,
		trustedTransportProvider: TARGET.provider,
		hotelName: "Zyd Agyad",
		roomName: "Deluxe Family Room 2",
		checkinDate: TARGET.checkinDate,
		checkoutDate: TARGET.checkoutDate,
		roomCount: 1,
		amount: TARGET.guestGross,
		totalAmountSar: TARGET.guestGross,
		totalPayoutSar: TARGET.hotelPayout,
		currency: "SAR",
		sourceCurrency: "SAR",
		sourceAmount: TARGET.guestGross,
		sourcePayoutAmount: TARGET.hotelPayout,
		sourcePayoutCurrency: "SAR",
		exchangeRateToSar: 1,
		exchangeRateSource: "identity",
		amountConvertedAt: "2026-08-11T17:57:03.525Z",
		paymentSummary: {
			sourceCurrency: "SAR",
			sourceTotalGuestPaymentAmount: TARGET.guestGross,
			sourceTotalPayoutAmount: TARGET.hotelPayout,
			sourceTotalPayoutCurrency: "SAR",
			totalGuestPaymentAmount: TARGET.guestGross,
			totalPayoutAmount: TARGET.hotelPayout,
			currency: "SAR",
			exchangeRateToSar: 1,
			exchangeRateSource: "identity",
			amountConvertedAt: "2026-08-11T17:57:03.525Z",
			propertyCurrency: "SAR",
			propertyConversionVerified: true,
		},
		otaCommissionSar: TARGET.otaCommission,
		otaCommissionSourceAmount: TARGET.otaCommission,
		otaCommissionCurrency: "SAR",
		otaCommissionSource: "agoda_commission",
		otaDeductionConflict: false,
		paymentCollectionModel: "ota_collect",
		paidOnline: true,
		inboundEmailId: TARGET.auditId,
		sourcePresence: {
			provider: true,
			confirmationNumber: true,
			hotelName: true,
			roomName: true,
			checkinDate: true,
			checkoutDate: true,
			roomCount: true,
			amount: true,
			otaCommission: true,
			paymentCollectionModel: true,
		},
		source: {
			textHash: sha("1"),
			receivedAt: "2026-08-11T17:57:03.525Z",
		},
	};
	const audit = {
		_id: oid(TARGET.auditId),
		__v: 0,
		hotelId: oid(TARGET.hotelId),
		provider: TARGET.provider,
		confirmationNumber: TARGET.confirmationNumber,
		intent: "new_reservation",
		eventType: "new",
		emailHash: sha("2"),
		senderAuthentication: {
			authenticatedAligned: true,
			trustedProvider: TARGET.provider,
		},
		normalizedReservation,
		processingStatus: "needs_review",
		automationAction: "skipped",
		skipReason: "hotelrunner_email_commercial_enrichment_guard_failed",
		automationComment:
			"HotelRunner owns the reservation, but the archived email commercial evidence requires review.",
		hasReservationConnection: true,
		reservationMongoId: oid(TARGET.reservationId),
		pmsConfirmationNumber: TARGET.pmsConfirmationNumber,
		matchedReservationBy: ["hotelrunner_first_fallback"],
		reconcileWarnings: [],
		reconcileErrors: [
			"Commercial enrichment gate failed: hotelrunner_amount.",
		],
		hotelRunnerFirstFallback: {
			status: "needs_review",
			jobId: TARGET.jobId,
			lastErrorCode:
				"hotelrunner_email_commercial_enrichment_guard_failed",
			lastErrorMessage:
				"HotelRunner owns the reservation, but the archived email commercial evidence requires review.",
			finalizedAt: new Date(TARGET.terminalAt),
			resolvedHotelProof: {
				version: 1,
				hotelId: TARGET.hotelId,
				belongsTo: TARGET.ownerId,
				currency: "SAR",
				activateHotel: true,
				xHotelProActive: true,
			},
		},
		reconciliation: {
			status: "needs_review",
			hotelRunnerFirstFallback: {
				jobId: TARGET.jobId,
				status: "needs_review",
				decision: "api_commercial_reconciliation_needs_review",
			},
		},
		updatedAt: new Date(TARGET.auditUpdatedAt),
	};
	const identity = {
		hotelId: TARGET.hotelId,
		provider: TARGET.provider,
		confirmationNumber: TARGET.confirmationNumber,
	};
	const fingerprint = createArchiveFingerprint({ identity, audit });
	const job = {
		_id: oid(TARGET.jobId),
		__v: 0,
		hotelId: oid(TARGET.hotelId),
		provider: TARGET.provider,
		confirmationNumber: TARGET.confirmationNumber,
		identityKey: TARGET.identityKey,
		inboundEmailId: oid(TARGET.auditId),
		inboundEmailHash: fingerprint.inboundEmailHash,
		archiveFingerprint: fingerprint.archiveFingerprint,
		normalizedReservationHash: fingerprint.normalizedReservationHash,
		resolvedHotelProofHash: fingerprint.resolvedHotelProofHash,
		lookupConfirmationNumber: fingerprint.lookupConfirmationNumber,
		lookupConfirmationHash: fingerprint.lookupConfirmationHash,
		hrIdFingerprint: sha("3"),
		status: "needs_review",
		attemptCount: 1,
		lookupAttemptCount: 0,
		lastDecision: "api_commercial_reconciliation_needs_review",
		lastErrorCode:
			"hotelrunner_email_commercial_enrichment_guard_failed",
		lastErrorMessage:
			"HotelRunner owns the reservation, but the archived email commercial evidence requires review.",
		completedAt: new Date(TARGET.terminalAt),
		inboundAuditFinalizationStatus: "completed",
		inboundAuditFinalizedAt: new Date(TARGET.terminalAt),
		reservationMongoId: oid(TARGET.reservationId),
		hotelRunnerEventId: oid(TARGET.eventId),
		hotelRunnerMirrorId: oid(TARGET.mirrorId),
		ingressDecision: { status: "api_observed" },
		identityConflict: false,
		result: { status: "needs_review" },
		updatedAt: new Date(TARGET.jobUpdatedAt),
	};
	const event = {
		_id: oid(TARGET.eventId),
		__v: 0,
		hotelId: oid(TARGET.hotelId),
		status: "completed",
		source: "push",
		hotelRunnerReservationId: TARGET.hotelRunnerReservationId,
		providerNumber: TARGET.confirmationNumber,
		channel: TARGET.channel,
		reservationMongoId: oid(TARGET.reservationId),
		mirrorId: oid(TARGET.mirrorId),
		errorCode: "",
		integrityConflict: false,
		result: { status: "created" },
		updatedAt: new Date("2026-08-11T17:58:27.226Z"),
	};
	const mirror = {
		_id: oid(TARGET.mirrorId),
		__v: 0,
		hotelId: oid(TARGET.hotelId),
		projectionStatus: "created",
		hotelRunnerReservationId: TARGET.hotelRunnerReservationId,
		providerNumber: TARGET.confirmationNumber,
		channel: TARGET.channel,
		reservationMongoId: oid(TARGET.reservationId),
		identityConflict: false,
		lastErrorCode: "",
		updatedAt: new Date("2026-08-11T17:58:27.216Z"),
	};
	const reservation = {
		_id: oid(TARGET.reservationId),
		__v: 0,
		hotelId: oid(TARGET.hotelId),
		belongsTo: oid(TARGET.ownerId),
		booking_source: TARGET.provider,
		otaIdentityKey: TARGET.identityKey,
		otaCrossTransportIdentityKey: "",
		confirmation_number: TARGET.pmsConfirmationNumber,
		checkin_date: new Date(TARGET.checkinDate),
		checkout_date: new Date(TARGET.checkoutDate),
		total_rooms: 1,
		total_amount: null,
		sub_total: TARGET.rootTotal,
		currency: "SAR",
		paid_amount: 0,
		payment: "not paid",
		financeStatus: "not paid",
		state: "confirmed",
		reservation_status: "confirmed",
		roomId: [],
		bedNumber: [],
		pickedRoomsType: [
			{
				count: 1,
				hotelRoomConfigId: "6a40e0981a6d1850eb25c27c",
				localRoomConfigId: "6a40e0981a6d1850eb25c27c",
				displayName:
					"Deluxe Family Room 2 - Non-Refundable - Room Only",
				sourceRoomName:
					"Deluxe Family Room 2 - Non-Refundable - Room Only",
				otaMatchedRoomName:
					"Deluxe Family Room 2 - Non-Refundable - Room Only",
				chosenPrice: TARGET.hotelRunnerReportedAmount,
				totalPriceWithCommission: TARGET.hotelRunnerReportedAmount,
				hotelShouldGet: TARGET.rootTotal,
				pricingByDay: [
					{
						date: TARGET.checkinDate,
						price: TARGET.hotelRunnerReportedAmount,
						clientPrice: TARGET.hotelRunnerReportedAmount,
						mainPrice: TARGET.hotelRunnerReportedAmount,
						totalPriceWithCommission: TARGET.hotelRunnerReportedAmount,
						rootPrice: TARGET.rootTotal,
					},
				],
			},
		],
		pickedRoomsPricing: [
			{
				count: 1,
				hotelRoomConfigId: "6a40e0981a6d1850eb25c27c",
				localRoomConfigId: "6a40e0981a6d1850eb25c27c",
				displayName:
					"Deluxe Family Room 2 - Non-Refundable - Room Only",
				sourceRoomName:
					"Deluxe Family Room 2 - Non-Refundable - Room Only",
				otaMatchedRoomName:
					"Deluxe Family Room 2 - Non-Refundable - Room Only",
				chosenPrice: TARGET.hotelRunnerReportedAmount,
				totalPriceWithCommission: TARGET.hotelRunnerReportedAmount,
				hotelShouldGet: TARGET.rootTotal,
				pricingByDay: [
					{
						date: TARGET.checkinDate,
						price: TARGET.hotelRunnerReportedAmount,
						clientPrice: TARGET.hotelRunnerReportedAmount,
						mainPrice: TARGET.hotelRunnerReportedAmount,
						totalPriceWithCommission: TARGET.hotelRunnerReportedAmount,
						rootPrice: TARGET.rootTotal,
					},
				],
			},
		],
		adminPricing: {
			mode: "hotelrunner_api",
			source: "hotelrunner_api",
			sourceCurrency: "SAR",
			propertyCurrency: "SAR",
			rootTotal: TARGET.rootTotal,
			clientTotal: null,
			sourceAmount: TARGET.hotelRunnerReportedAmount,
			commercialVerified: false,
		},
		ota_financial_summary: {
			source: "hotelrunner_api",
			sourceCurrency: "SAR",
			hotelVisibleAmount: TARGET.rootTotal,
			clientTotal: null,
			sourceAmount: TARGET.hotelRunnerReportedAmount,
			commercialVerified: false,
		},
		supplierData: {
			otaProvider: TARGET.provider,
			otaConfirmationNumber: TARGET.confirmationNumber,
			platformConfirmationNumber: TARGET.confirmationNumber,
			suppliedBookingNo: TARGET.confirmationNumber,
			otaSourceAuthority: 4,
			otaAutomationPipeline: "hotelrunner_background_worker",
			hotelRunner: {
				transport: "hotelrunner_api",
				reservationId: TARGET.hotelRunnerReservationId,
				reportedPaymentMethod: "not paid",
				pricing: {
					grandTotal: TARGET.hotelRunnerReportedAmount,
					currency: "SAR",
				},
			},
			otaCommercialEvidence: buildHotelRunnerUnresolvedCommercialEvidence({
				provider: TARGET.provider,
				sourceType: "hotelrunner_webhook",
				reportedAmount: TARGET.hotelRunnerReportedAmount,
				reportedCurrency: "SAR",
				propertyCurrency: "SAR",
				sourceHash: sha("5"),
				sourceTimestamp: "2026-08-11T17:58:17.000Z",
				sourceId: TARGET.eventId,
			}),
		},
	};
	const hotel = {
		_id: oid(TARGET.hotelId),
		belongsTo: oid(TARGET.ownerId),
		currency: "SAR",
		activateHotel: true,
		xHotelProActive: true,
		hotelName: "Zyd Agyad",
		roomCountDetails: [
			{
				_id: oid("6a40e0981a6d1850eb25c27c"),
				activeRoom: true,
				displayName: "Deluxe Family Room 2",
				displayName_OtherLanguage: "",
			},
		],
	};
	return {
		job,
		audit,
		event,
		mirror,
		reservation,
		hotel,
		counts: { jobs: 1, audits: 1, events: 1, mirrors: 1, reservations: 1 },
	};
}

function dotted(document, key) {
	return String(key)
		.split(".")
		.reduce((value, part) => value?.[part], document);
}

function equalValue(left, right) {
	if (
		lowerBsonType(left) === "objectid" ||
		lowerBsonType(right) === "objectid"
	) {
		return String(left) === String(right);
	}
	return left === right;
}

const lowerBsonType = (value) => String(value?._bsontype || "").toLowerCase();

function matches(document, filter = {}) {
	for (const [key, expected] of Object.entries(filter)) {
		if (key === "$expr") continue;
		if (key === "$or") {
			if (!expected.some((entry) => matches(document, entry))) return false;
			continue;
		}
		const actual = dotted(document, key);
		if (Array.isArray(actual)) {
			if (!actual.some((value) => equalValue(value, expected))) return false;
		} else if (!equalValue(actual, expected)) {
			return false;
		}
	}
	return true;
}

function memoryCollection(initial = []) {
	const documents = new Map(
		initial.map((document) => [String(document._id), cloneFullBson(document)])
	);
	let replaceNumber = 0;
	let failReplaceNumber = 0;
	return {
		documents,
		setFailReplaceNumber(value) {
			failReplaceNumber = value;
		},
		async findOne(filter) {
			return cloneFullBson(
				[...documents.values()].find((document) => matches(document, filter)) || null
			);
		},
		find(filter) {
			return {
				toArray: async () =>
					cloneFullBson(
						[...documents.values()].filter((document) =>
							matches(document, filter)
						)
					),
			};
		},
		async insertOne(document) {
			const key = String(document._id);
			if (documents.has(key)) {
				const error = new Error("duplicate");
				error.code = 11000;
				throw error;
			}
			documents.set(key, cloneFullBson(document));
			return { acknowledged: true, insertedId: document._id };
		},
		async replaceOne(filter, replacement) {
			replaceNumber += 1;
			if (failReplaceNumber && replaceNumber === failReplaceNumber) {
				return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
			}
			const key = String(filter._id);
			const current = documents.get(key);
			const literal = filter?.$expr?.$eq?.[1]?.$literal;
			const expected = Array.isArray(literal)
				? Object.fromEntries(literal.map(({ k, v }) => [k, v]))
				: null;
			if (
				!current ||
				!expected ||
				canonicalEjsonSha256(current) !== canonicalEjsonSha256(expected)
			) {
				return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
			}
			documents.set(key, cloneFullBson(replacement));
			return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
		},
		async updateOne(filter, update) {
			const entry = [...documents.entries()].find(([, document]) =>
				matches(document, filter)
			);
			if (!entry) return { matchedCount: 0, modifiedCount: 0 };
			const updated = applyUpdateToDocument(entry[1], update);
			documents.set(entry[0], updated);
			return { matchedCount: 1, modifiedCount: 1 };
		},
	};
}

function fixtureCollections(scope = fixtureScope()) {
	return {
		jobs: memoryCollection([scope.job]),
		audits: memoryCollection([scope.audit]),
		events: memoryCollection([scope.event]),
		mirrors: memoryCollection([scope.mirror]),
		reservations: memoryCollection([scope.reservation]),
		hotels: memoryCollection([scope.hotel]),
		backups: memoryCollection([]),
	};
}

test("arguments require every explicit apply attestation", () => {
	assert.deepEqual(parseArguments([]).apply, false);
	assert.throws(() => parseArguments(["--scope=2040450395"]), /apply-only/i);
	assert.throws(
		() => parseArguments(["--apply"]),
		(error) => error.code === "AGODA_2040450395_RECOVERY_REPAIR_ID_REQUIRED"
	);
	const parsed = parseArguments([
		"--apply",
		`--repair-id=${REPAIR_ID}`,
		`--scope=${SCOPE_ATTESTATION}`,
		`--proof=${PLANNED_AT.getTime()}.${sha("4")}`,
		`--release-sha=${RELEASE}`,
		`--worker-stopped=${WORKER_UNIT}`,
	]);
	assert.equal(parsed.apply, true);
});

test("proofs are bounded against age and future clock skew", () => {
	const proof = `${PLANNED_AT.getTime()}.${sha("4")}`;
	assert.equal(parseProof(proof, APPLY_AT).scopeHash, sha("4"));
	assert.throws(
		() => parseProof(proof, new Date(PLANNED_AT.getTime() + 31 * 60_000)),
		(error) => error.code === "AGODA_2040450395_RECOVERY_PROOF_EXPIRED"
	);
	assert.throws(
		() => parseProof(proof, new Date(PLANNED_AT.getTime() - 6_000)),
		(error) => error.code === "AGODA_2040450395_RECOVERY_PROOF_EXPIRED"
	);
});

test("the exact production-shaped terminal scope validates", () => {
	const validated = validateScope(fixtureScope(), { commercialPreflight });
	assert.equal(validated.archive.ok, true);
	assert.deepEqual(validated.commercial, commercialSummary());
});

test("the real commercial guard accepts the exact production-shaped fixture", () => {
	const validated = validateScope(fixtureScope());
	assert.equal(validated.commercial.reportedTotalRole, "payout");
	assert.equal(validated.commercial.guestGross, TARGET.guestGross);
});

test("terminal, ownership, duplicate, and protected-state drift fail closed", () => {
	for (const mutate of [
		(scope) => (scope.job.status = "retry"),
		(scope) => (scope.audit.reconcileErrors = []),
		(scope) => (scope.event.reservationMongoId = null),
		(scope) => (scope.mirror.identityConflict = true),
		(scope) => (scope.reservation.roomId = [oid("6a40e0981a6d1850eb25c27c")]),
		(scope) => (scope.counts.reservations = 2),
	]) {
		const scope = fixtureScope();
		mutate(scope);
		assert.throws(
			() => validateScope(scope, { commercialPreflight }),
			(error) => error.code === "AGODA_2040450395_RECOVERY_SCOPE_DRIFT"
		);
	}
});

test("the commercial preflight is mandatory and part of the proof", () => {
	const first = buildPlan(fixtureScope(), PLANNED_AT, RELEASE, PLANNED_AT, "", {
		commercialPreflight,
	});
	const changedPreflight = () => ({ ...commercialSummary(), guestGross: 87.23 });
	const second = buildPlan(
		fixtureScope(),
		PLANNED_AT,
		RELEASE,
		PLANNED_AT,
		"",
		{ commercialPreflight: changedPreflight }
	);
	assert.notEqual(first.scopeHash, second.scopeHash);
	assert.throws(
		() =>
			buildPlan(fixtureScope(), PLANNED_AT, RELEASE, PLANNED_AT, "", {
				commercialPreflight: () => {
					throw new Error("guard rejected");
				},
			}),
		/guard rejected/
	);
});

test("the plan writes only audit then job and preserves API ownership links", () => {
	const plan = buildPlan(fixtureScope(), PLANNED_AT, RELEASE, APPLY_AT, OWNER_TOKEN, {
		commercialPreflight,
	});
	assert.deepEqual(
		plan.documentPlans.map(({ role }) => role),
		["audit", "job"]
	);
	const audit = plan.documentPlans[0].expectedDocument;
	const job = plan.documentPlans[1].expectedDocument;
	assert.equal(audit.processingStatus, "awaiting_hotelrunner");
	assert.equal(audit.automationComment, AWAITING_MESSAGE);
	assert.equal(String(audit.reservationMongoId), TARGET.reservationId);
	assert.equal(audit.hasReservationConnection, true);
	assert.equal(job.status, "awaiting_hotelrunner");
	assert.equal(String(job.reservationMongoId), TARGET.reservationId);
	assert.equal(String(job.hotelRunnerEventId), TARGET.eventId);
	assert.equal(String(job.hotelRunnerMirrorId), TARGET.mirrorId);
	assert.equal(job.ingressDecision.status, "api_observed");
	assert.equal(
		job.nextAttemptAt.getTime(),
		APPLY_AT.getTime() + JOB_HOLD_MS
	);
});

test("proof binds the full read-only event/mirror/reservation evidence", () => {
	const first = buildPlan(fixtureScope(), PLANNED_AT, RELEASE, PLANNED_AT, "", {
		commercialPreflight,
	});
	const changed = fixtureScope();
	changed.event.updatedAt = new Date("2026-08-11T17:58:28.226Z");
	const second = buildPlan(changed, PLANNED_AT, RELEASE, PLANNED_AT, "", {
		commercialPreflight,
	});
	assert.notEqual(first.scopeHash, second.scopeHash);
	assert.notEqual(first.originalHashes.event, second.originalHashes.event);
});

test("permanent backups contain exact full BSON originals and evidence hashes", () => {
	const plan = buildPlan(fixtureScope(), PLANNED_AT, RELEASE, PLANNED_AT, "", {
		commercialPreflight,
	});
	for (const documentPlan of plan.documentPlans) {
		const record = backupRecord(documentPlan, plan, APPLY_AT);
		assert.equal(record.collectionName.includes("reservations"), false);
		assert.equal(verifyBackup(record, record), true);
		const changed = cloneFullBson(record);
		changed.originalDocument.status = "tampered";
		assert.throws(() => verifyBackup(changed, record), /backup failed integrity/i);
	}
	assert.equal(BACKUP_COLLECTION.includes("2040450395"), true);
});

test("release and topology attestations fail closed", async () => {
	assert.equal(
		validateReleaseAttestation({
			releaseSha: RELEASE,
			treeSha: TREE,
			capturedAt: PLANNED_AT,
		}),
		RELEASE
	);
	assert.throws(
		() =>
			validateReleaseAttestation(
				{ releaseSha: RELEASE, treeSha: TREE, capturedAt: PLANNED_AT },
				"d".repeat(40)
			),
		(error) => error.code === "AGODA_2040450395_RECOVERY_RELEASE_MISMATCH"
	);
	assert.equal(
		await assertStandaloneWritablePrimary({
			command: async () => ({ ok: 1, isWritablePrimary: true }),
		}),
		true
	);
	await assert.rejects(
		assertStandaloneWritablePrimary({
			command: async () => ({ ok: 1, isWritablePrimary: true, setName: "rs0" }),
		}),
		(error) => error.code === "AGODA_2040450395_RECOVERY_TOPOLOGY_UNATTESTED"
	);
});

test("worker gate requires the exact loaded and inactive systemd state", () => {
	assert.equal(
		validateWorkerUnitState("LoadState=loaded\nActiveState=inactive\n"),
		true
	);
	for (const output of [
		"LoadState=loaded\nActiveState=active\n",
		"LoadState=not-found\nActiveState=inactive\n",
		"",
	]) {
		assert.throws(
			() => validateWorkerUnitState(output),
			(error) =>
				error.code === "AGODA_2040450395_RECOVERY_WORKER_NOT_STOPPED"
		);
	}
});

test("apply stops before backups or writes when the worker gate rejects", async () => {
	const scope = fixtureScope();
	const collections = fixtureCollections(scope);
	const dryPlan = buildPlan(scope, PLANNED_AT, RELEASE, PLANNED_AT, "", {
		commercialPreflight,
	});
	await assert.rejects(
		applyRecovery({
			collections,
			proof: proofToken(dryPlan),
			releaseSha: RELEASE,
			now: APPLY_AT,
			ownerToken: OWNER_TOKEN,
			commercialPreflight,
			resolveReleaseAttestation: async () => ({
				releaseSha: RELEASE,
				treeSha: TREE,
				capturedAt: APPLY_AT,
			}),
			assertWorkerStopped: async () => {
				const error = new Error("worker active");
				error.code = "AGODA_2040450395_RECOVERY_WORKER_NOT_STOPPED";
				throw error;
			},
		}),
		(error) => error.code === "AGODA_2040450395_RECOVERY_WORKER_NOT_STOPPED"
	);
	assert.equal(collections.backups.documents.size, 0);
	assert.equal(collections.jobs.documents.get(TARGET.jobId).status, "needs_review");
	assert.equal(
		collections.audits.documents.get(TARGET.auditId).processingStatus,
		"needs_review"
	);
});

test("apply creates two backups and reopens exactly two documents", async () => {
	const scope = fixtureScope();
	const collections = fixtureCollections(scope);
	assert.ok(await collections.jobs.findOne({ _id: oid(TARGET.jobId) }));
	const dryPlan = buildPlan(scope, PLANNED_AT, RELEASE, PLANNED_AT, "", {
		commercialPreflight,
	});
	const result = await applyRecovery({
		collections,
		proof: proofToken(dryPlan),
		releaseSha: RELEASE,
		now: APPLY_AT,
		ownerToken: OWNER_TOKEN,
		commercialPreflight,
		resolveReleaseAttestation: async () => ({
			releaseSha: RELEASE,
			treeSha: TREE,
			capturedAt: APPLY_AT,
		}),
		assertWorkerStopped: async () => true,
	});
	assert.equal(result.changed, 2);
	assert.equal(result.backupCount, 2);
	assert.equal(collections.jobs.documents.get(TARGET.jobId).status, "awaiting_hotelrunner");
	assert.equal(
		collections.audits.documents.get(TARGET.auditId).processingStatus,
		"awaiting_hotelrunner"
	);
	assert.equal(
		canonicalEjsonSha256(collections.reservations.documents.get(TARGET.reservationId)),
		canonicalEjsonSha256(scope.reservation)
	);
	assert.equal(
		collections.backups.documents.get(`${REPAIR_ID}:apply-lock`).state,
		"applied"
	);
});

test("scope drift after dry run blocks before either coordinator document changes", async () => {
	const scope = fixtureScope();
	const dryPlan = buildPlan(scope, PLANNED_AT, RELEASE, PLANNED_AT, "", {
		commercialPreflight,
	});
	const collections = fixtureCollections(scope);
	collections.events.documents.get(TARGET.eventId).updatedAt = new Date(
		"2026-08-11T17:59:27.226Z"
	);
	await assert.rejects(
		applyRecovery({
			collections,
			proof: proofToken(dryPlan),
			releaseSha: RELEASE,
			now: APPLY_AT,
			ownerToken: OWNER_TOKEN,
			commercialPreflight,
			resolveReleaseAttestation: async () => ({
				releaseSha: RELEASE,
				treeSha: TREE,
				capturedAt: APPLY_AT,
			}),
			assertWorkerStopped: async () => true,
		}),
		(error) => error.code === "AGODA_2040450395_RECOVERY_PROOF_MISMATCH"
	);
	assert.equal(collections.jobs.documents.get(TARGET.jobId).status, "needs_review");
	assert.equal(
		collections.audits.documents.get(TARGET.auditId).processingStatus,
		"needs_review"
	);
});

test("a second CAS failure compensates the first write exactly", async () => {
	const scope = fixtureScope();
	const collections = fixtureCollections(scope);
	const dryPlan = buildPlan(scope, PLANNED_AT, RELEASE, PLANNED_AT, "", {
		commercialPreflight,
	});
	collections.jobs.setFailReplaceNumber(1);
	await assert.rejects(
		applyRecovery({
			collections,
			proof: proofToken(dryPlan),
			releaseSha: RELEASE,
			now: APPLY_AT,
			ownerToken: OWNER_TOKEN,
			commercialPreflight,
			resolveReleaseAttestation: async () => ({
				releaseSha: RELEASE,
				treeSha: TREE,
				capturedAt: APPLY_AT,
			}),
			assertWorkerStopped: async () => true,
		}),
		(error) => error.code === "AGODA_2040450395_RECOVERY_COMPENSATED"
	);
	assert.equal(
		canonicalEjsonSha256(collections.jobs.documents.get(TARGET.jobId)),
		canonicalEjsonSha256(scope.job)
	);
	assert.equal(
		canonicalEjsonSha256(collections.audits.documents.get(TARGET.auditId)),
		canonicalEjsonSha256(scope.audit)
	);
	assert.equal(
		collections.backups.documents.get(`${REPAIR_ID}:apply-lock`).state,
		"compensated"
	);
});

test("a hard crash after audit-first leaves no claimable worker job", () => {
	const scope = fixtureScope();
	const plan = buildPlan(scope, PLANNED_AT, RELEASE, APPLY_AT, OWNER_TOKEN, {
		commercialPreflight,
	});
	const auditOnlyCrashImage = plan.documentPlans[0].expectedDocument;
	assert.equal(auditOnlyCrashImage.processingStatus, "awaiting_hotelrunner");
	assert.equal(scope.job.status, "needs_review");
	assert.equal(
		["awaiting_hotelrunner", "retry", "processing"].includes(scope.job.status),
		false
	);
	assert.equal(plan.documentPlans[1].role, "job");
});

test("the utility has no direct Reservation mutation surface", () => {
	const source = fs.readFileSync(
		path.resolve(__dirname, "recoverAgoda2040450395Commercial20260811.js"),
		"utf8"
	);
	assert.doesNotMatch(source, /Reservations\.(?:updateOne|replaceOne|findOneAndUpdate|create|save)\s*\(/);
	assert.doesNotMatch(source, /collections\.reservations\.(?:updateOne|replaceOne|insertOne|deleteOne)\s*\(/);
	assert.doesNotMatch(
		source,
		/collections\.(?:events|mirrors|hotels)\.(?:updateOne|replaceOne|insertOne|deleteOne)\s*\(/
	);
	assert.match(source, /mutationOrder:\s*\["audit",\s*"job"\]/);
	assert.match(source, /assertExactGitRelease/);
	assert.match(source, /Deliberately non-reclaimable/);
});
