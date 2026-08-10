/** @format */

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const mongoose = require("mongoose");
const { Binary, Decimal128, Long, deserialize, serialize } = require("bson");

const {
	APPLY_STRATEGIES,
	BACKUP_COLLECTION,
	MANIFEST_COLLECTION,
	PROOF_MAX_AGE_MS,
	REPAIR_ID,
	STANDALONE_EVENT_HOLD_MS,
	STANDALONE_LOCK_MS,
	TARGET,
	applyRecovery,
	applyFullBsonUpdateToDocument,
	backupRecord,
	buildEventRequeueUpdate,
	buildFullDocumentCasFilter,
	buildPlan,
	cloneFullBson,
	loadScope,
	manifestRecord,
	parseArguments,
	parseProof,
	preparedManifestRecord,
	proofToken,
	resolveApplyStrategy,
	validateIdentityAndEvidence,
	validateOriginalFailure,
} = require("./recoverHotelRunnerExpedia2531071530Event20260810");
const {
	canonicalEjsonSha256,
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
		this.updateOneOptions = [];
		this.insertOneOptions = [];
	}

	async findOne(filter) {
		this.findOneCalls += 1;
		return this.documents.get(id(filter._id)) || null;
	}

	async insertOne(document, options) {
		this.insertOneCalls += 1;
		this.insertOneOptions.push(options);
		const key = id(document._id);
		if (this.documents.has(key)) {
			const error = new Error("duplicate key");
			error.code = 11000;
			throw error;
		}
		this.documents.set(key, document);
		return { acknowledged: true, insertedId: document._id };
	}

	async updateOne(filter, update, options) {
		this.updateOneCalls += 1;
		this.updateOneOptions.push(options);
		const expectedEntries = filter?.$expr?.$eq?.[1]?.$literal;
		const expected = Array.isArray(expectedEntries)
			? Object.fromEntries(expectedEntries.map((entry) => [entry.k, entry.v]))
			: filter?.$and?.[0];
		const current = this.documents.get(id(expected?._id || filter._id));
		if (
			!current ||
			(expected &&
				canonicalEjsonSha256(current) !== canonicalEjsonSha256(expected))
		) {
			return { matchedCount: 0, modifiedCount: 0 };
		}
		this.documents.set(
			id(current._id),
			applyFullBsonUpdateToDocument(current, update)
		);
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
		PLAN_AT.getTime() + STANDALONE_EVENT_HOLD_MS
	);
	assert.match(plan.basis.recoveryMarker, /^[a-f0-9]{64}$/);
	assert.equal(
		plan.basis.update.$set.result.incidentRecovery.marker,
		plan.basis.recoveryMarker
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
	assert.equal(collections.events.updateOneCalls, 2);
	assert.equal(collections.mirrors.updateOneCalls, 0);
	assert.equal(collections.reservations.updateOneCalls, 0);
	assert.equal(collections.backups.insertOneCalls, 1);
	assert.equal(collections.manifests.insertOneCalls, 1);
	assert.equal(canonicalEjsonSha256(scope.mirror), mirrorBefore);
	assert.equal(canonicalEjsonSha256(scope.reservation), reservationBefore);

	const event = collections.events.documents.get(scope.target.eventId);
	assert.equal(event.status, "pending");
	assert.equal(Number(event.attempts), 0);
	assert.equal(event.errorCode, "");
	assert.equal(event.errorMessage, "");
	assert.equal(event.processedAt, null);
	assert.equal(Number(event.__v), 2);
	assert.equal(event.reservationMongoId, null);
	assert.equal(event.mirrorId, null);
	const backup = collections.backups.documents.get(REPAIR_ID);
	assert.equal(
		canonicalEjsonSha256(backup.originalDocument),
		scope.target.eventDocumentHash
	);
	assert.equal(backup.originalDocument.status, "failed");
	assert.equal(Number(backup.originalDocument.attempts), 8);
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

test("topology attestation selects transactions or a positive writable standalone", async () => {
	const admin = (reply) => ({ command: async () => reply });
	assert.equal(
		await resolveApplyStrategy(
			admin({ ok: 1, isWritablePrimary: true, maxWireVersion: 17 })
		),
		APPLY_STRATEGIES.STANDALONE
	);
	assert.equal(
		await resolveApplyStrategy(
			admin({ ok: 1, isWritablePrimary: true, setName: "rs0" })
		),
		APPLY_STRATEGIES.TRANSACTION
	);
	assert.equal(
		await resolveApplyStrategy(
			admin({ ok: 1, isWritablePrimary: true, msg: "isdbgrid" })
		),
		APPLY_STRATEGIES.TRANSACTION
	);
	await assert.rejects(
		resolveApplyStrategy(admin({ ok: 1, isWritablePrimary: false })),
		(error) =>
			error.code === "HOTELRUNNER_EXPEDIA_EVENT_RECOVERY_PRIMARY_REQUIRED"
	);
	await assert.rejects(
		resolveApplyStrategy(
			admin({
				ok: 1,
				isWritablePrimary: true,
				hosts: ["ambiguous-cluster-member"],
			})
		),
		(error) =>
			error.code === "HOTELRUNNER_EXPEDIA_EVENT_RECOVERY_TOPOLOGY_UNSUPPORTED"
	);
	await assert.rejects(
		resolveApplyStrategy(admin({ isWritablePrimary: true })),
		(error) =>
			error.code === "HOTELRUNNER_EXPEDIA_EVENT_RECOVERY_PRIMARY_REQUIRED"
	);
});

test("standalone apply durably orders backup, prepared manifest, event CAS, final manifest", async () => {
	const { scope, collections } = fixtureCollections();
	const proof = proofToken(buildPlan(scope, PLAN_AT, scope.target));
	const operations = [];
	for (const [role, method] of [
		["backup", "insertOne"],
		["manifest", "insertOne"],
		["event", "updateOne"],
		["manifest", "updateOne"],
	]) {
		const collection =
			role === "backup"
				? collections.backups
				: role === "manifest"
				? collections.manifests
				: collections.events;
		const original = collection[method].bind(collection);
		collection[method] = async (...arguments_) => {
			operations.push(`${role}.${method}`);
			return original(...arguments_);
		};
	}
	let transactionCalls = 0;
	const result = await applyRecovery({
		collections,
		proof,
		now: APPLY_AT,
		target: scope.target,
		applyStrategy: APPLY_STRATEGIES.STANDALONE,
		ownerToken: hash("a"),
		runTransaction: async () => {
			transactionCalls += 1;
		},
	});
	assert.equal(transactionCalls, 0);
	assert.deepEqual(operations, [
		"backup.insertOne",
		"manifest.insertOne",
		"event.updateOne",
		"manifest.updateOne",
		"event.updateOne",
	]);
	assert.equal(result.applyStrategy, APPLY_STRATEGIES.STANDALONE);
	assert.equal(result.changed, 1);
	assert.equal(result.plan.state, "requeued_pending");
	for (const options of [
		...collections.backups.insertOneOptions,
		...collections.manifests.insertOneOptions,
		...collections.manifests.updateOneOptions,
		...collections.events.updateOneOptions,
	]) {
		assert.deepEqual(options?.writeConcern, { w: "majority" });
	}
	const manifest = collections.manifests.documents.get(REPAIR_ID);
	assert.equal(manifest.state, "applied");
	assert.equal(manifest.ownerToken, undefined);
	assert.equal(manifest.completionOwnerTokenHash.length, 64);
	const event = collections.events.documents.get(scope.target.eventId);
	assert.equal(
		event.result.incidentRecovery.marker,
		result.plan.basis.recoveryMarker
	);
});

test("standalone readback recovers lost acknowledgements at every durable write", async (t) => {
	for (const fault of [
		{ role: "backups", method: "insertOne", call: 1 },
		{ role: "manifests", method: "insertOne", call: 1 },
		{ role: "events", method: "updateOne", call: 1 },
		{ role: "manifests", method: "updateOne", call: 1 },
		{ role: "events", method: "updateOne", call: 2 },
	]) {
		await t.test(
			`${fault.role}.${fault.method} acknowledgement loss`,
			async () => {
				const { scope, collections } = fixtureCollections();
				const proof = proofToken(buildPlan(scope, PLAN_AT, scope.target));
				const collection = collections[fault.role];
				const original = collection[fault.method].bind(collection);
				let calls = 0;
				collection[fault.method] = async (...arguments_) => {
					calls += 1;
					const result = await original(...arguments_);
					if (calls === fault.call)
						throw new Error("simulated acknowledgement loss");
					return result;
				};
				const result = await applyRecovery({
					collections,
					proof,
					now: APPLY_AT,
					target: scope.target,
					applyStrategy: APPLY_STRATEGIES.STANDALONE,
					ownerToken: hash("b"),
				});
				assert.equal(result.acknowledgementRecovered, true);
				assert.equal(result.plan.state, "requeued_pending");
				assert.equal(
					collections.manifests.documents.get(REPAIR_ID).state,
					"applied"
				);
			}
		);
	}
});

test("standalone backup-only crash is safely resumed without touching the event early", async () => {
	const { scope, collections } = fixtureCollections();
	const proof = proofToken(buildPlan(scope, PLAN_AT, scope.target));
	const originalManifestInsert = collections.manifests.insertOne.bind(
		collections.manifests
	);
	collections.manifests.insertOne = async () => {
		throw new Error("simulated kill before prepared manifest");
	};
	await assert.rejects(
		applyRecovery({
			collections,
			proof,
			now: APPLY_AT,
			target: scope.target,
			applyStrategy: APPLY_STRATEGIES.STANDALONE,
			ownerToken: hash("c"),
		})
	);
	assert.equal(collections.backups.documents.has(REPAIR_ID), true);
	assert.equal(collections.manifests.documents.has(REPAIR_ID), false);
	assert.equal(
		canonicalEjsonSha256(
			collections.events.documents.get(scope.target.eventId)
		),
		scope.target.eventDocumentHash
	);
	collections.manifests.insertOne = originalManifestInsert;
	const resumed = await applyRecovery({
		collections,
		proof,
		now: new Date(APPLY_AT.getTime() + 1_000),
		target: scope.target,
		applyStrategy: APPLY_STRATEGIES.STANDALONE,
		ownerToken: hash("d"),
	});
	assert.equal(resumed.changed, 1);
	assert.equal(resumed.plan.state, "requeued_pending");
});

test("prepared original event is fenced until lock expiry, then safely adopted", async () => {
	const { scope, collections } = fixtureCollections();
	const proof = proofToken(buildPlan(scope, PLAN_AT, scope.target));
	const originalEventUpdate = collections.events.updateOne.bind(
		collections.events
	);
	collections.events.updateOne = async () => {
		throw new Error("simulated kill before event CAS");
	};
	await assert.rejects(
		applyRecovery({
			collections,
			proof,
			now: APPLY_AT,
			target: scope.target,
			applyStrategy: APPLY_STRATEGIES.STANDALONE,
			ownerToken: hash("e"),
		})
	);
	assert.equal(
		collections.manifests.documents.get(REPAIR_ID).state,
		"prepared"
	);
	assert.equal(
		canonicalEjsonSha256(
			collections.events.documents.get(scope.target.eventId)
		),
		scope.target.eventDocumentHash
	);
	collections.events.updateOne = originalEventUpdate;
	await assert.rejects(
		applyRecovery({
			collections,
			proof,
			now: new Date(APPLY_AT.getTime() + 1_000),
			target: scope.target,
			applyStrategy: APPLY_STRATEGIES.STANDALONE,
			ownerToken: hash("f"),
		}),
		(error) => error.code === "HOTELRUNNER_EXPEDIA_EVENT_RECOVERY_LOCK_ACTIVE"
	);
	const resumed = await applyRecovery({
		collections,
		proof,
		now: new Date(APPLY_AT.getTime() + STANDALONE_LOCK_MS + 1),
		target: scope.target,
		applyStrategy: APPLY_STRATEGIES.STANDALONE,
		ownerToken: hash("f"),
	});
	assert.equal(resumed.changed, 1);
	assert.equal(resumed.plan.state, "requeued_pending");
});

test("prepared exact event is roll-forward only after finalization failure", async () => {
	const { scope, collections } = fixtureCollections();
	const proof = proofToken(buildPlan(scope, PLAN_AT, scope.target));
	const originalManifestUpdate = collections.manifests.updateOne.bind(
		collections.manifests
	);
	collections.manifests.updateOne = async () => {
		throw new Error("simulated kill before manifest finalization");
	};
	await assert.rejects(
		applyRecovery({
			collections,
			proof,
			now: APPLY_AT,
			target: scope.target,
			applyStrategy: APPLY_STRATEGIES.STANDALONE,
			ownerToken: hash("6"),
		})
	);
	assert.equal(
		collections.manifests.documents.get(REPAIR_ID).state,
		"prepared"
	);
	assert.equal(
		buildPlan(
			await loadScope(collections, null, scope.target),
			PLAN_AT,
			scope.target
		).state,
		"prepared_requeued"
	);
	collections.manifests.updateOne = originalManifestUpdate;
	const resumed = await applyRecovery({
		collections,
		proof,
		now: new Date(APPLY_AT.getTime() + STANDALONE_LOCK_MS + 1),
		target: scope.target,
		applyStrategy: APPLY_STRATEGIES.STANDALONE,
		ownerToken: hash("7"),
	});
	assert.equal(resumed.changed, 1);
	assert.equal(resumed.plan.state, "requeued_pending");
	assert.equal(collections.events.updateOneCalls, 2);
});

test("stale-lock CAS loser does not claim a competing owner's state", async () => {
	const { scope, collections } = fixtureCollections();
	const plan = buildPlan(scope, PLAN_AT, scope.target);
	const proof = proofToken(plan);
	collections.backups.documents.set(
		REPAIR_ID,
		backupRecord(plan, new Date(PLAN_AT.getTime() - STANDALONE_LOCK_MS * 2))
	);
	collections.manifests.documents.set(
		REPAIR_ID,
		preparedManifestRecord(
			plan,
			new Date(PLAN_AT.getTime() - STANDALONE_LOCK_MS * 2),
			hash("8")
		)
	);
	collections.manifests.updateOne = async () => {
		const competing = collections.manifests.documents.get(REPAIR_ID);
		competing.ownerToken = hash("9");
		competing.lockAcquiredAt = new Date(APPLY_AT);
		competing.lockUntil = new Date(APPLY_AT.getTime() + STANDALONE_LOCK_MS);
		return { matchedCount: 0, modifiedCount: 0 };
	};
	await assert.rejects(
		applyRecovery({
			collections,
			proof,
			now: APPLY_AT,
			target: scope.target,
			applyStrategy: APPLY_STRATEGIES.STANDALONE,
			ownerToken: hash("a"),
		}),
		(error) => error.code === "HOTELRUNNER_EXPEDIA_EVENT_RECOVERY_LOCK_CAS_LOST"
	);
	assert.equal(
		collections.manifests.documents.get(REPAIR_ID).ownerToken,
		hash("9")
	);
	assert.equal(
		canonicalEjsonSha256(
			collections.events.documents.get(scope.target.eventId)
		),
		scope.target.eventDocumentHash
	);
});

test("prepared arbitrary active state is never attributed to recovery", async () => {
	const { scope, collections } = fixtureCollections();
	const plan = buildPlan(scope, PLAN_AT, scope.target);
	const proof = proofToken(plan);
	collections.backups.documents.set(REPAIR_ID, backupRecord(plan, APPLY_AT));
	collections.manifests.documents.set(
		REPAIR_ID,
		preparedManifestRecord(
			plan,
			new Date(APPLY_AT.getTime() - STANDALONE_LOCK_MS * 2),
			hash("b")
		)
	);
	const event = collections.events.documents.get(scope.target.eventId);
	event.status = "pending";
	event.updatedAt = new Date(APPLY_AT);
	await assert.rejects(
		applyRecovery({
			collections,
			proof,
			now: APPLY_AT,
			target: scope.target,
			applyStrategy: APPLY_STRATEGIES.STANDALONE,
			ownerToken: hash("c"),
		}),
		(error) =>
			error.code === "HOTELRUNNER_EXPEDIA_EVENT_RECOVERY_PREPARED_STATE_DRIFT"
	);
	assert.equal(collections.manifests.updateOneCalls, 0);
});

test("full-document CAS rejects a missing null field swapped for an extra root field", async () => {
	const document = {
		_id: oid(TARGET.eventId),
		nullableLease: null,
		stable: "same",
	};
	const swapped = {
		_id: oid(TARGET.eventId),
		stable: "same",
		unexpectedRootField: "same-root-count",
	};
	const collection = new FakeCollection([swapped]);
	const filter = buildFullDocumentCasFilter(document);
	assert.deepEqual(filter.$expr.$eq[0], { $objectToArray: "$$ROOT" });
	const missed = await collection.updateOne(filter, {
		$set: { stable: "unsafe" },
	});
	assert.equal(missed.matchedCount, 0);
	assert.equal(collection.documents.get(TARGET.eventId).stable, "same");

	const exactCollection = new FakeCollection([document]);
	const matched = await exactCollection.updateOne(filter, {
		$set: { stable: "safe" },
	});
	assert.equal(matched.matchedCount, 1);
	assert.equal(exactCollection.documents.get(TARGET.eventId).stable, "safe");
});

test("backup, CAS literal, and projections preserve unknown BSON values exactly", () => {
	const scope = fixtureScope();
	scope.event.unknownFullBson = {
		long: Long.fromString("9223372036854775806"),
		decimal: Decimal128.fromString("1234567890.123400"),
		binary: new Binary(Buffer.from([0, 1, 2, 253, 254, 255])),
		unknownNestedField: "preserve-me",
	};
	scope.target = {
		...scope.target,
		eventDocumentHash: canonicalEjsonSha256(scope.event),
	};
	const plan = buildPlan(scope, PLAN_AT, scope.target);
	const backup = backupRecord(plan, APPLY_AT);
	const filter = buildFullDocumentCasFilter(scope.event);
	const expectedDocument = Object.fromEntries(
		filter.$expr.$eq[1].$literal.map((entry) => [entry.k, entry.v])
	);
	const projection = applyFullBsonUpdateToDocument(
		backup.originalDocument,
		plan.basis.update
	);
	for (const document of [
		backup.originalDocument,
		expectedDocument,
		projection,
		cloneFullBson(scope.event),
	]) {
		assert.equal(Long.isLong(document.unknownFullBson.long), true);
		assert.equal(
			document.unknownFullBson.long.toString(),
			"9223372036854775806"
		);
		assert.equal(
			document.unknownFullBson.decimal.toString(),
			"1234567890.123400"
		);
		assert.deepEqual(
			Array.from(document.unknownFullBson.binary.buffer),
			[0, 1, 2, 253, 254, 255]
		);
		assert.equal(document.unknownFullBson.unknownNestedField, "preserve-me");
	}
	assert.equal(
		canonicalEjsonSha256(backup.originalDocument),
		scope.target.eventDocumentHash
	);
});

test("prepared recovery blocks unvalidated mirror drift before event CAS", async () => {
	const { scope, collections } = fixtureCollections();
	const plan = buildPlan(scope, PLAN_AT, scope.target);
	const proof = proofToken(plan);
	collections.backups.documents.set(REPAIR_ID, backupRecord(plan, APPLY_AT));
	collections.manifests.documents.set(
		REPAIR_ID,
		preparedManifestRecord(
			plan,
			new Date(APPLY_AT.getTime() - STANDALONE_LOCK_MS * 2),
			hash("1")
		)
	);
	collections.mirrors.documents.get(
		scope.target.mirrorId
	).unvalidatedLifecycle = "changed-after-proof";
	await assert.rejects(
		applyRecovery({
			collections,
			proof,
			now: APPLY_AT,
			target: scope.target,
			applyStrategy: APPLY_STRATEGIES.STANDALONE,
			ownerToken: hash("2"),
		}),
		(error) => error.code === "HOTELRUNNER_EXPEDIA_EVENT_RECOVERY_SCOPE_DRIFT"
	);
	assert.equal(collections.events.updateOneCalls, 0);
	assert.equal(collections.manifests.updateOneCalls, 0);
});

test("held event is never released when reservation drifts during finalization", async () => {
	const { scope, collections } = fixtureCollections();
	const proof = proofToken(buildPlan(scope, PLAN_AT, scope.target));
	const originalFinalize = collections.manifests.updateOne.bind(
		collections.manifests
	);
	collections.manifests.updateOne = async (...arguments_) => {
		collections.reservations.documents.get(
			scope.target.reservationMongoId
		).unvalidatedLifecycle = "changed-before-finalization";
		return originalFinalize(...arguments_);
	};
	await assert.rejects(
		applyRecovery({
			collections,
			proof,
			now: APPLY_AT,
			target: scope.target,
			applyStrategy: APPLY_STRATEGIES.STANDALONE,
			ownerToken: hash("3"),
		}),
		(error) => error.code === "HOTELRUNNER_EXPEDIA_EVENT_RECOVERY_SCOPE_DRIFT"
	);
	const event = collections.events.documents.get(scope.target.eventId);
	assert.equal(event.status, "pending");
	assert.equal(event.result.incidentRecovery.releaseMarker, undefined);
	assert.equal(
		event.nextAttemptAt.getTime(),
		PLAN_AT.getTime() + STANDALONE_EVENT_HOLD_MS
	);
	assert.equal(collections.events.updateOneCalls, 1);
	assert.equal(collections.manifests.documents.get(REPAIR_ID).state, "applied");
});

test("standalone applied rerun is an idempotent no-op", async () => {
	const { scope, collections } = fixtureCollections();
	const proof = proofToken(buildPlan(scope, PLAN_AT, scope.target));
	const first = await applyRecovery({
		collections,
		proof,
		now: APPLY_AT,
		target: scope.target,
		applyStrategy: APPLY_STRATEGIES.STANDALONE,
		ownerToken: hash("d"),
	});
	assert.equal(first.changed, 1);
	const eventWrites = collections.events.updateOneCalls;
	const second = await applyRecovery({
		collections,
		proof,
		now: new Date(APPLY_AT.getTime() + 1_000),
		target: scope.target,
		applyStrategy: APPLY_STRATEGIES.STANDALONE,
		ownerToken: hash("e"),
	});
	assert.equal(second.changed, 0);
	assert.equal(second.plan.state, "requeued_pending");
	assert.equal(collections.events.updateOneCalls, eventWrites);
});

test("near-expiry apply keeps the event unclaimable until the manifest is applied", async () => {
	const { scope, collections } = fixtureCollections();
	const plan = buildPlan(scope, PLAN_AT, scope.target);
	const proof = proofToken(plan);
	const nearExpiry = new Date(PLAN_AT.getTime() + PROOF_MAX_AGE_MS - 1_000);
	const originalFinalize = collections.manifests.updateOne.bind(
		collections.manifests
	);
	let claimAttempted = false;
	collections.manifests.updateOne = async (...arguments_) => {
		const event = collections.events.documents.get(scope.target.eventId);
		assert.equal(event.status, "pending");
		assert.ok(
			event.nextAttemptAt.getTime() >=
				nearExpiry.getTime() + 2 * STANDALONE_LOCK_MS
		);
		if (event.nextAttemptAt.getTime() <= nearExpiry.getTime()) {
			claimAttempted = true;
			event.status = "processing";
			event.leaseUntil = new Date(nearExpiry.getTime() + 60_000);
		}
		return originalFinalize(...arguments_);
	};
	const result = await applyRecovery({
		collections,
		proof,
		now: nearExpiry,
		target: scope.target,
		applyStrategy: APPLY_STRATEGIES.STANDALONE,
		ownerToken: hash("f"),
	});
	assert.equal(claimAttempted, false);
	assert.equal(result.plan.state, "requeued_pending");
	assert.equal(collections.manifests.documents.get(REPAIR_ID).state, "applied");
});
