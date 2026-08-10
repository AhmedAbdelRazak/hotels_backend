/** @format */

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const mongoose = require("mongoose");
const { deserialize, serialize } = require("bson");

const {
	BACKUP_COLLECTION,
	MANIFEST_COLLECTION,
	PROOF_MAX_AGE_MS,
	REPAIR_ID,
	TARGET,
	applyRecovery,
	backupRecord,
	buildEventRequeueUpdate,
	buildPlan,
	loadScope,
	manifestRecord,
	parseArguments,
	parseProof,
	proofToken,
	validateIdentityAndEvidence,
	validateOriginalFailure,
} = require("./recoverHotelRunnerExpedia2531071530Event20260810");
const {
	applyUpdateToDocument,
	canonicalEjsonSha256,
	cloneBson,
} = require("../services/tripHotelRunnerRepair20260805");

const PLAN_AT = new Date("2026-08-10T16:00:00.000Z");
const APPLY_AT = new Date("2026-08-10T16:01:00.000Z");
const hash = (character) => character.repeat(64);
const oid = (value) => new mongoose.Types.ObjectId(value);
const id = (value) => String(value?._id || value || "").toLowerCase();

function fixtureScope() {
	const event = {
		_id: oid(TARGET.eventId),
		__v: 0,
		eventKey: hash("1"),
		messageUid: "a123f52ab11df7f677e4b9499d6d46f8",
		payloadHash: TARGET.eventPayloadHash,
		canonicalHash: TARGET.eventCanonicalHash,
		source: "push",
		hotelId: oid(TARGET.hotelId),
		hotelRunnerReservationId: TARGET.hotelRunnerReservationId,
		hrNumber: TARGET.hrNumber,
		providerNumber: TARGET.confirmationNumber,
		channel: TARGET.provider,
		state: "confirmed",
		modified: false,
		sourceUpdatedAt: new Date(TARGET.eventSourceUpdatedAt),
		payload: { protectedOriginalPayload: true },
		status: TARGET.eventStatus,
		attempts: TARGET.eventAttempts,
		nextAttemptAt: new Date("2026-08-10T11:55:53.542Z"),
		finalRecoveryAttempted: false,
		finalRecoveryClaimedAt: null,
		integrityReason: "",
		integrityConflict: false,
		integrityConflictCount: 0,
		errorCode: TARGET.eventErrorCode,
		errorMessage: TARGET.eventErrorMessage,
		reservationMongoId: null,
		mirrorId: null,
		result: {},
		deliveryCount: 1,
		lastReceivedAt: new Date(TARGET.eventReceivedAt),
		remoteConfirmation: {
			status: "not_required",
			attempts: 0,
			lastAttemptAt: null,
			confirmedAt: null,
			lastError: "",
		},
		receivedAt: new Date(TARGET.eventReceivedAt),
		processedAt: new Date(TARGET.eventProcessedAt),
		createdAt: new Date("2026-08-10T11:34:34.552Z"),
		updatedAt: new Date(TARGET.eventUpdatedAt),
	};
	const normalizedSnapshot = {
		channel: "expedia",
		currency: "USD",
		checkinDate: TARGET.checkinDate,
		checkoutDate: TARGET.checkoutDate,
		hotelRunnerReservationId: TARGET.hotelRunnerReservationId,
		hrNumber: TARGET.hrNumber,
		providerNumber: TARGET.confirmationNumber,
		itemTotalCents: TARGET.portalPayoutCents,
		subTotalCents: TARGET.portalPayoutCents,
		totalCents: TARGET.portalPayoutCents,
		totalRooms: 1,
		rooms: [
			{
				invCode: TARGET.hotelRunnerInvCode,
				roomId: TARGET.hotelRunnerRoomId,
				checkinDate: TARGET.checkinDate,
				checkoutDate: TARGET.checkoutDate,
				totalCents: TARGET.portalPayoutCents,
			},
		],
	};
	const mirror = {
		_id: oid(TARGET.mirrorId),
		__v: 0,
		hotelId: oid(TARGET.hotelId),
		hrIdFingerprint: hash("2"),
		hotelRunnerReservationId: TARGET.hotelRunnerReservationId,
		hrNumber: TARGET.hrNumber,
		providerNumber: TARGET.confirmationNumber,
		channel: TARGET.provider,
		state: "confirmed",
		observedSourceUpdatedAt: new Date(TARGET.eventSourceUpdatedAt),
		observedCanonicalHash: TARGET.eventCanonicalHash,
		appliedSourceUpdatedAt: null,
		appliedCanonicalHash: "",
		lastMessageUid: event.messageUid,
		reservationMongoId: null,
		projectionStatus: "pending",
		projectionVersion: 0,
		normalizedSnapshot,
		lastAppliedProjection: {},
		lastResult: {},
		lastErrorCode: "",
		lastErrorMessage: "",
		createdAt: new Date("2026-08-10T11:34:34.899Z"),
		updatedAt: new Date("2026-08-10T11:34:34.899Z"),
	};
	const commercialEvidence = {
		contractVersion: 1,
		provider: "expedia",
		sourceType: "authenticated_provider_portal",
		sourceCurrency: "USD",
		propertyCurrency: "SAR",
		bookingBasis: "reservation_total",
		verificationState: "verified",
		roles: {
			guestGross: {
				verified: true,
				sourceAmount: TARGET.portalGuestGross,
				sourceCurrency: "USD",
				propertyAmount: TARGET.propertyGuestGross,
				propertyCurrency: "SAR",
				sourceRef: "primary",
			},
			hotelPayout: {
				verified: true,
				sourceAmount: TARGET.portalPayout,
				sourceCurrency: "USD",
				propertyAmount: TARGET.propertyPayout,
				propertyCurrency: "SAR",
				sourceRef: "primary",
			},
		},
		provenance: {
			primary: {
				provider: "expedia",
				sourceType: "authenticated_provider_portal",
				sourceHash: hash("3"),
			},
		},
		evidenceHash: hash("4"),
	};
	const paymentSummary = {
		sourceCurrency: "USD",
		sourceTotalGuestPaymentAmount: TARGET.portalGuestGross,
		sourceTotalPayoutAmount: TARGET.portalPayout,
		sourceTotalPayoutCurrency: "USD",
		totalGuestPaymentAmount: TARGET.propertyGuestGross,
		totalPayoutAmount: TARGET.propertyPayout,
		currency: "SAR",
		exchangeRateToSar: TARGET.exchangeRate,
	};
	const pickedRoomsType = [
		{
			room_type: TARGET.roomType,
			hotelRoomConfigId: oid(TARGET.roomConfigId),
			sourceRoomName: "Comfort Triple Room, Private Bathroom, Mountain View",
			chosenPrice: 533.1,
			count: 1,
			totalPriceWithCommission: TARGET.propertyGuestGross,
			hotelShouldGet: 4000,
		},
	];
	const reservation = {
		_id: oid(TARGET.reservationMongoId),
		__v: 0,
		hotelId: oid(TARGET.hotelId),
		belongsTo: oid(TARGET.ownerId),
		confirmation_number: TARGET.pmsConfirmationNumber,
		reservation_id: TARGET.confirmationNumber,
		hr_number: "",
		otaIdentityKey: TARGET.otaIdentityKey,
		otaCrossTransportIdentityKey: "",
		booking_source: TARGET.provider,
		state: "ota platform review",
		reservation_status: "ota platform review",
		checkin_date: new Date(`${TARGET.checkinDate}T00:00:00.000Z`),
		checkout_date: new Date(`${TARGET.checkoutDate}T00:00:00.000Z`),
		total_rooms: 1,
		currency: "sar",
		total_amount: TARGET.propertyGuestGross,
		sub_total: 4000,
		pickedRoomsType,
		supplierData: {
			otaProvider: "expedia",
			suppliedBookingNo: TARGET.confirmationNumber,
			otaConfirmationNumber: TARGET.confirmationNumber,
			otaCommercialEvidence: commercialEvidence,
			otaPaymentSummary: paymentSummary,
		},
		createdAt: new Date("2026-08-10T15:44:03.455Z"),
		updatedAt: new Date("2026-08-10T15:44:03.455Z"),
	};
	const target = {
		...TARGET,
		eventDocumentHash: canonicalEjsonSha256(event),
		mirrorDocumentHash: canonicalEjsonSha256(mirror),
		mirrorSnapshotHash: canonicalEjsonSha256(normalizedSnapshot),
		reservationDocumentHash: canonicalEjsonSha256(reservation),
		commercialEvidenceHash: commercialEvidence.evidenceHash,
		commercialEvidenceDocumentHash: canonicalEjsonSha256(commercialEvidence),
		pickedRoomsHash: canonicalEjsonSha256(pickedRoomsType),
		paymentSummaryHash: canonicalEjsonSha256(paymentSummary),
	};
	return {
		target,
		event,
		mirror,
		reservation,
		backup: null,
		manifest: null,
	};
}

class FakeCollection {
	constructor(documents = []) {
		this.documents = new Map(
			documents.map((document) => [id(document._id), document])
		);
		this.findOneCalls = 0;
		this.updateOneCalls = 0;
		this.insertOneCalls = 0;
	}

	async findOne(filter) {
		this.findOneCalls += 1;
		return this.documents.get(id(filter._id)) || null;
	}

	async insertOne(document) {
		this.insertOneCalls += 1;
		const key = id(document._id);
		if (this.documents.has(key)) {
			const error = new Error("duplicate key");
			error.code = 11000;
			throw error;
		}
		this.documents.set(key, document);
		return { acknowledged: true, insertedId: document._id };
	}

	async updateOne(filter, update) {
		this.updateOneCalls += 1;
		const expected = filter?.$and?.[0];
		const current = expected
			? this.documents.get(id(expected._id))
			: this.documents.get(id(filter._id));
		if (
			!current ||
			(expected &&
				canonicalEjsonSha256(current) !== canonicalEjsonSha256(expected))
		) {
			return { matchedCount: 0, modifiedCount: 0 };
		}
		this.documents.set(id(current._id), applyUpdateToDocument(current, update));
		return { matchedCount: 1, modifiedCount: 1 };
	}
}

function fixtureCollections() {
	const scope = fixtureScope();
	return {
		scope,
		collections: {
			events: new FakeCollection([scope.event]),
			mirrors: new FakeCollection([scope.mirror]),
			reservations: new FakeCollection([scope.reservation]),
			backups: new FakeCollection(),
			manifests: new FakeCollection(),
		},
	};
}

test("scope is the exact Expedia event, mirror, and provider-portal reservation", () => {
	assert.equal(TARGET.eventId, "6a79b74ad8cbed2f4bad4757");
	assert.equal(TARGET.mirrorId, "6a79b74a4d62ce1e740adc83");
	assert.equal(TARGET.reservationMongoId, "6a79f1c3427e3b7cd6f16284");
	assert.equal(TARGET.confirmationNumber, "2531071530");
	assert.equal(TARGET.portalPayout, 438.4);
	assert.equal(TARGET.eventAttempts, 8);
	assert.equal(
		TARGET.eventErrorCode,
		"hotelrunner_currency_waiting_for_email_bridge"
	);
});

test("only the event and durable recovery records are mutable", () => {
	const source = fs.readFileSync(
		path.resolve(
			__dirname,
			"recoverHotelRunnerExpedia2531071530Event20260810.js"
		),
		"utf8"
	);
	assert.doesNotMatch(source, /reservations\.updateOne\s*\(/);
	assert.doesNotMatch(source, /mirrors\.updateOne\s*\(/);
	assert.doesNotMatch(source, /audits\.updateOne\s*\(/);
	assert.match(source, /events\.updateOne\s*\(/);
});

test("apply CLI requires the exact repair ID and dry-run proof", () => {
	assert.deepEqual(parseArguments([]), {
		apply: false,
		repairId: "",
		proof: "",
		help: false,
	});
	assert.throws(
		() => parseArguments(["--apply"]),
		(error) =>
			error.code === "HOTELRUNNER_EXPEDIA_EVENT_RECOVERY_REPAIR_ID_REQUIRED"
	);
	assert.throws(
		() => parseArguments([`--repair-id=${REPAIR_ID}`]),
		(error) =>
			error.code === "HOTELRUNNER_EXPEDIA_EVENT_RECOVERY_ARGUMENT_INVALID"
	);
	const proof = `${PLAN_AT.getTime()}.${hash("a")}`;
	const parsed = parseArguments([
		"--apply",
		`--repair-id=${REPAIR_ID}`,
		`--proof=${proof}`,
	]);
	assert.equal(parsed.apply, true);
	assert.equal(parsed.proof, proof);
	assert.throws(
		() => parseProof(proof, new Date(PLAN_AT.getTime() + PROOF_MAX_AGE_MS + 1)),
		(error) => error.code === "HOTELRUNNER_EXPEDIA_EVENT_RECOVERY_PROOF_EXPIRED"
	);
});

test("exact portal payout role equals HotelRunner USD 438.40", () => {
	const scope = fixtureScope();
	assert.equal(validateIdentityAndEvidence(scope, scope.target), true);
	assert.equal(validateOriginalFailure(scope, scope.target), true);
	scope.reservation.supplierData.otaCommercialEvidence.roles.hotelPayout.sourceAmount = 438.41;
	assert.throws(
		() => validateIdentityAndEvidence(scope, scope.target),
		(error) => error.code === "HOTELRUNNER_EXPEDIA_EVENT_RECOVERY_SCOPE_DRIFT"
	);
});

test("dry-run proof binds the immutable evidence and deterministic event update", () => {
	const scope = fixtureScope();
	const plan = buildPlan(scope, PLAN_AT, scope.target);
	assert.equal(plan.state, "ready");
	assert.match(proofToken(plan), /^\d{13}\.[a-f0-9]{64}$/);
	assert.equal(plan.basis.originalEventHash, scope.target.eventDocumentHash);
	assert.equal(plan.basis.update.$set.status, "pending");
	assert.equal(plan.basis.update.$set.attempts, 0);
	assert.equal(
		plan.basis.update.$set.nextAttemptAt.getTime(),
		PLAN_AT.getTime()
	);
	assert.equal(plan.basis.update.$inc.__v, 1);
});

test("backup and manifest hashes survive a Mongo BSON round trip", () => {
	const scope = fixtureScope();
	const plan = buildPlan(scope, PLAN_AT, scope.target);
	const backup = deserialize(serialize(backupRecord(plan, APPLY_AT)));
	const manifest = deserialize(serialize(manifestRecord(plan, APPLY_AT)));
	assert.equal(
		canonicalEjsonSha256(backup.originalDocument),
		plan.basis.originalEventHash
	);
	assert.equal(canonicalEjsonSha256(manifest.planBasis), plan.planHash);
	assert.equal(manifest.expectedEventHash, plan.basis.expectedEventHash);
});

test("apply backs up the full event and requeues only that event", async () => {
	const fixture = fixtureCollections();
	const { scope, collections } = fixture;
	const dryRun = buildPlan(scope, PLAN_AT, scope.target);
	const proof = proofToken(dryRun);
	const mirrorBefore = canonicalEjsonSha256(scope.mirror);
	const reservationBefore = canonicalEjsonSha256(scope.reservation);
	let transactionCalls = 0;
	const result = await applyRecovery({
		collections,
		proof,
		now: APPLY_AT,
		target: scope.target,
		runTransaction: async (work) => {
			transactionCalls += 1;
			return work({ testSession: true });
		},
	});
	assert.equal(transactionCalls, 1);
	assert.equal(result.changed, 1);
	assert.equal(result.plan.state, "requeued_pending");
	assert.equal(collections.events.updateOneCalls, 1);
	assert.equal(collections.mirrors.updateOneCalls, 0);
	assert.equal(collections.reservations.updateOneCalls, 0);
	assert.equal(collections.backups.insertOneCalls, 1);
	assert.equal(collections.manifests.insertOneCalls, 1);
	assert.equal(canonicalEjsonSha256(scope.mirror), mirrorBefore);
	assert.equal(canonicalEjsonSha256(scope.reservation), reservationBefore);

	const event = collections.events.documents.get(scope.target.eventId);
	assert.equal(event.status, "pending");
	assert.equal(event.attempts, 0);
	assert.equal(event.errorCode, "");
	assert.equal(event.errorMessage, "");
	assert.equal(event.processedAt, null);
	assert.equal(event.__v, 1);
	assert.equal(event.reservationMongoId, null);
	assert.equal(event.mirrorId, null);
	const backup = collections.backups.documents.get(REPAIR_ID);
	assert.equal(
		canonicalEjsonSha256(backup.originalDocument),
		scope.target.eventDocumentHash
	);
	assert.equal(backup.originalDocument.status, "failed");
	assert.equal(backup.originalDocument.attempts, 8);
	assert.equal(collections.manifests.documents.get(REPAIR_ID).state, "applied");
});

test("repeating apply with the same proof is an idempotent no-op", async () => {
	const { scope, collections } = fixtureCollections();
	const proof = proofToken(buildPlan(scope, PLAN_AT, scope.target));
	const transaction = async (work) => work({ testSession: true });
	const first = await applyRecovery({
		collections,
		proof,
		now: APPLY_AT,
		target: scope.target,
		runTransaction: transaction,
	});
	assert.equal(first.changed, 1);
	const eventWrites = collections.events.updateOneCalls;
	const second = await applyRecovery({
		collections,
		proof,
		now: new Date(APPLY_AT.getTime() + 1_000),
		target: scope.target,
		runTransaction: transaction,
	});
	assert.equal(second.changed, 0);
	assert.equal(second.plan.state, "requeued_pending");
	assert.equal(collections.events.updateOneCalls, eventWrites);
	assert.equal(collections.backups.insertOneCalls, 1);
	assert.equal(collections.manifests.insertOneCalls, 1);
});

test("reads sharing the Expedia recovery transaction session are sequential", async () => {
	const { scope, collections } = fixtureCollections();
	let active = 0;
	let maximumActive = 0;
	for (const role of [
		"events",
		"mirrors",
		"reservations",
		"backups",
		"manifests",
	]) {
		const original = collections[role].findOne.bind(collections[role]);
		collections[role].findOne = async (...arguments_) => {
			active += 1;
			maximumActive = Math.max(maximumActive, active);
			await Promise.resolve();
			const result = await original(...arguments_);
			active -= 1;
			return result;
		};
	}
	await loadScope(collections, { transactionSession: true }, scope.target);
	assert.equal(maximumActive, 1);
});

test("readback recognizes exact worker convergence without another write", async () => {
	const { scope, collections } = fixtureCollections();
	const proof = proofToken(buildPlan(scope, PLAN_AT, scope.target));
	await applyRecovery({
		collections,
		proof,
		now: APPLY_AT,
		target: scope.target,
		runTransaction: async (work) => work({ testSession: true }),
	});
	const event = collections.events.documents.get(scope.target.eventId);
	const mirror = collections.mirrors.documents.get(scope.target.mirrorId);
	event.status = "completed";
	event.reservationMongoId = oid(scope.target.reservationMongoId);
	event.mirrorId = oid(scope.target.mirrorId);
	mirror.projectionStatus = "updated";
	mirror.reservationMongoId = oid(scope.target.reservationMongoId);
	const plan = buildPlan(
		await loadScope(collections, null, scope.target),
		PLAN_AT,
		scope.target
	);
	assert.equal(plan.state, "converged");
});

test("full-document CAS miss fails closed", async () => {
	const { scope, collections } = fixtureCollections();
	const proof = proofToken(buildPlan(scope, PLAN_AT, scope.target));
	collections.events.updateOne = async () => ({
		matchedCount: 0,
		modifiedCount: 0,
	});
	await assert.rejects(
		applyRecovery({
			collections,
			proof,
			now: APPLY_AT,
			target: scope.target,
			runTransaction: async (work) => work({ testSession: true }),
		}),
		(error) =>
			error.code === "HOTELRUNNER_EXPEDIA_EVENT_RECOVERY_EVENT_CAS_LOST"
	);
});

test("event reset clears failure/lease fields but never prelinks the mirror", () => {
	const update = buildEventRequeueUpdate(PLAN_AT);
	assert.equal(update.$set.status, "pending");
	assert.equal(update.$set.attempts, 0);
	assert.equal(update.$set.finalRecoveryAttempted, false);
	assert.equal(update.$set.finalRecoveryClaimedAt, null);
	assert.equal(update.$unset.leaseOwner, "");
	assert.equal(update.$set.reservationMongoId, undefined);
	assert.equal(update.$set.mirrorId, undefined);
	assert.equal(BACKUP_COLLECTION.includes("2531071530"), true);
	assert.equal(MANIFEST_COLLECTION.includes("2531071530"), true);
});
