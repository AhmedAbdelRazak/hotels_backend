/** @format */

"use strict";

/**
 * Event-only replay for Expedia 2531071530 after an exact, authenticated
 * provider-portal reservation was materialized in the PMS.
 *
 * The script never mutates the PMS reservation, HotelRunner mirror, or inbound
 * audits. Apply is gated by the exact repair ID plus an unexpired proof from a
 * dry run. The full failed event is durably backed up before a full-document
 * compare-and-set requeues only that event.
 *
 * Dry run (default):
 *   node scripts/recoverHotelRunnerExpedia2531071530Event20260810.js
 *
 * Apply (use the proof printed by the dry run):
 *   node scripts/recoverHotelRunnerExpedia2531071530Event20260810.js \
 *     --apply \
 *     --repair-id=hotelrunner-expedia-2531071530-event-20260810-v1 \
 *     --proof=<dry-run-proof>
 */

const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const mongoose = require("mongoose");

mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);

const {
	applyUpdateToDocument,
	buildExactCasFilter,
	canonicalEjsonSha256,
	cloneBson,
} = require("../services/tripHotelRunnerRepair20260805");

const REPAIR_ID = "hotelrunner-expedia-2531071530-event-20260810-v1";
const BACKUP_COLLECTION =
	"ota_hotelrunner_expedia_2531071530_event_backup_20260810_v1";
const MANIFEST_COLLECTION =
	"ota_hotelrunner_expedia_2531071530_event_manifest_20260810_v1";
const PROOF_MAX_AGE_MS = 30 * 60 * 1000;
const CLOCK_SKEW_MS = 5_000;

const COLLECTION_NAMES = Object.freeze({
	events: "hotelrunnerevents",
	mirrors: "hotelrunnerreservations",
	reservations: "reservations",
	backups: BACKUP_COLLECTION,
	manifests: MANIFEST_COLLECTION,
});

const TARGET = Object.freeze({
	hotelId: "6a40b6a1a6efe70450536038",
	ownerId: "68b74714fb50e159d48c714d",
	provider: "expedia",
	confirmationNumber: "2531071530",
	otaIdentityKey: "expedia:2531071530",
	hotelRunnerReservationId: "40398339",
	hrNumber: "R243093657",
	eventId: "6a79b74ad8cbed2f4bad4757",
	mirrorId: "6a79b74a4d62ce1e740adc83",
	reservationMongoId: "6a79f1c3427e3b7cd6f16284",
	pmsConfirmationNumber: "2810329919",
	eventVersion: 0,
	eventAttempts: 8,
	eventStatus: "failed",
	eventErrorCode: "hotelrunner_currency_waiting_for_email_bridge",
	eventErrorMessage: "HotelRunner reservation changed concurrently.",
	eventReceivedAt: "2026-08-10T11:34:34.528Z",
	eventSourceUpdatedAt: "2026-08-10T11:32:23.000Z",
	eventProcessedAt: "2026-08-10T11:45:13.542Z",
	eventUpdatedAt: "2026-08-10T11:45:13.542Z",
	eventPayloadHash:
		"a2240905ff9192b93b7c50e87fcb1b96cb7dc354e9153e8e47a9942fa25d06e9",
	eventCanonicalHash:
		"af95e345ad76ce111832801aed70e286612b58a07cc2297b6fd92a4a23569a2c",
	eventDocumentHash:
		"cb7579487dcce05d8107de69a464a0938fdca9b3c20ea677d5224ed350644fa6",
	mirrorDocumentHash:
		"2ed16bb3e054d941101059e29dcd98d92fd185aa6c8a5397e87109b90de11ab4",
	mirrorSnapshotHash:
		"3dbd7582d772b8eb7ef93c8984050b677f42ba6d069225ab3660cdc44fa39933",
	reservationDocumentHash:
		"cc14119fa9f78dcbde7a06f81ed6169adbcd37341025a9a13af4ef62270f568a",
	commercialEvidenceHash:
		"e9029bdd37799a9b37093d3be485312eec3a7af972a317e4602aed2328752eb3",
	commercialEvidenceDocumentHash:
		"9a289fb2464bcdb542b9398b65466a9cb161c514368c6b7b15c6f9c79ac870b3",
	pickedRoomsHash:
		"4c15a59b271a3ed38f85b0c3d64779c4e794b9725bb2c7eaa11a628fccdbb6a8",
	paymentSummaryHash:
		"ae4c73190dc2d0570eb53865b21474757af84f8486c056e36f88b9717e3bf744",
	checkinDate: "2027-03-04",
	checkoutDate: "2027-03-08",
	roomType: "tripleRooms",
	roomConfigId: "6a40e0981a6d1850eb25c27c",
	hotelRunnerRoomId: "36224418",
	hotelRunnerInvCode: "HR:1332587",
	totalRooms: 1,
	nights: 4,
	propertyCurrency: "SAR",
	sourceCurrency: "USD",
	portalGuestGross: 568.64,
	portalPayout: 438.4,
	portalPayoutCents: 43840,
	propertyGuestGross: 2132.4,
	propertyPayout: 1644,
	exchangeRate: 3.75,
});

class RecoveryError extends Error {
	constructor(message, code = "HOTELRUNNER_EXPEDIA_EVENT_RECOVERY_FAILED") {
		super(message);
		this.name = "RecoveryError";
		this.code = code;
	}
}

const fail = (message, code) => {
	throw new RecoveryError(message, code);
};

const clean = (value) => String(value ?? "").trim();
const lower = (value) => clean(value).toLowerCase();
const id = (value) => lower(value?._id || value);
const oid = (value) => new mongoose.Types.ObjectId(clean(value));
const cents = (value) => Math.round(Number(value) * 100);
const dateMs = (value) => {
	const parsed = value instanceof Date ? value : new Date(value);
	return Number.isFinite(parsed.getTime()) ? parsed.getTime() : NaN;
};
const dateKey = (value) => {
	const milliseconds = dateMs(value);
	return Number.isFinite(milliseconds)
		? new Date(milliseconds).toISOString().slice(0, 10)
		: "";
};
const sameDate = (value, expected) => dateMs(value) === dateMs(expected);
const validObjectId = (value) => mongoose.Types.ObjectId.isValid(id(value));
const validSha256 = (value) => /^[a-f0-9]{64}$/i.test(clean(value));

function parseArguments(argv = []) {
	const options = { apply: false, repairId: "", proof: "", help: false };
	for (const argument of argv) {
		if (argument === "--apply") options.apply = true;
		else if (argument === "--help" || argument === "-h") options.help = true;
		else if (argument.startsWith("--repair-id=")) {
			if (options.repairId) {
				fail(
					"--repair-id may only be supplied once.",
					"HOTELRUNNER_EXPEDIA_EVENT_RECOVERY_ARGUMENT_INVALID"
				);
			}
			options.repairId = clean(argument.slice("--repair-id=".length));
		} else if (argument.startsWith("--proof=")) {
			if (options.proof) {
				fail(
					"--proof may only be supplied once.",
					"HOTELRUNNER_EXPEDIA_EVENT_RECOVERY_ARGUMENT_INVALID"
				);
			}
			options.proof = lower(argument.slice("--proof=".length));
		} else {
			fail(
				`Unknown argument: ${argument}`,
				"HOTELRUNNER_EXPEDIA_EVENT_RECOVERY_ARGUMENT_INVALID"
			);
		}
	}
	if (!options.apply && (options.repairId || options.proof)) {
		fail(
			"--repair-id and --proof are apply-only arguments.",
			"HOTELRUNNER_EXPEDIA_EVENT_RECOVERY_ARGUMENT_INVALID"
		);
	}
	if (options.apply && options.repairId !== REPAIR_ID) {
		fail(
			`--apply requires --repair-id=${REPAIR_ID}.`,
			"HOTELRUNNER_EXPEDIA_EVENT_RECOVERY_REPAIR_ID_REQUIRED"
		);
	}
	if (options.apply && !/^\d{13}\.[a-f0-9]{64}$/.test(options.proof)) {
		fail(
			"--apply requires the exact unexpired dry-run proof.",
			"HOTELRUNNER_EXPEDIA_EVENT_RECOVERY_PROOF_REQUIRED"
		);
	}
	return options;
}

function parseProof(proof, now = new Date()) {
	const match = lower(proof).match(/^(\d{13})\.([a-f0-9]{64})$/);
	if (!match) {
		fail(
			"The dry-run proof format is invalid.",
			"HOTELRUNNER_EXPEDIA_EVENT_RECOVERY_PROOF_INVALID"
		);
	}
	const plannedAtMs = Number(match[1]);
	const nowMs = new Date(now).getTime();
	if (
		!Number.isSafeInteger(plannedAtMs) ||
		plannedAtMs > nowMs + CLOCK_SKEW_MS ||
		nowMs - plannedAtMs > PROOF_MAX_AGE_MS
	) {
		fail(
			"The dry-run proof is expired or from the future.",
			"HOTELRUNNER_EXPEDIA_EVENT_RECOVERY_PROOF_EXPIRED"
		);
	}
	return { plannedAt: new Date(plannedAtMs), planHash: match[2] };
}

function collectionsFromDb(db) {
	return {
		events: db.collection(COLLECTION_NAMES.events),
		mirrors: db.collection(COLLECTION_NAMES.mirrors),
		reservations: db.collection(COLLECTION_NAMES.reservations),
		backups: db.collection(COLLECTION_NAMES.backups),
		manifests: db.collection(COLLECTION_NAMES.manifests),
	};
}

async function loadScope(collections, session = null, target = TARGET) {
	const options = session ? { session } : undefined;
	if (session) {
		const event = await collections.events.findOne(
			{ _id: oid(target.eventId) },
			options
		);
		const mirror = await collections.mirrors.findOne(
			{ _id: oid(target.mirrorId) },
			options
		);
		const reservation = await collections.reservations.findOne(
			{ _id: oid(target.reservationMongoId) },
			options
		);
		const backup = await collections.backups.findOne(
			{ _id: REPAIR_ID },
			options
		);
		const manifest = await collections.manifests.findOne(
			{ _id: REPAIR_ID },
			options
		);
		return { target, event, mirror, reservation, backup, manifest };
	}
	const [event, mirror, reservation, backup, manifest] = await Promise.all([
		collections.events.findOne({ _id: oid(target.eventId) }, options),
		collections.mirrors.findOne({ _id: oid(target.mirrorId) }, options),
		collections.reservations.findOne(
			{ _id: oid(target.reservationMongoId) },
			options
		),
		collections.backups.findOne({ _id: REPAIR_ID }, options),
		collections.manifests.findOne({ _id: REPAIR_ID }, options),
	]);
	return { target, event, mirror, reservation, backup, manifest };
}

function requireCondition(
	condition,
	label,
	code = "HOTELRUNNER_EXPEDIA_EVENT_RECOVERY_SCOPE_DRIFT"
) {
	if (!condition) fail(`Exact recovery precondition failed: ${label}.`, code);
}

function validateIdentityAndEvidence(
	{ event, mirror, reservation },
	target = TARGET,
	{ requireOriginalHashes = false } = {}
) {
	requireCondition(event && mirror && reservation, "required document missing");
	requireCondition(id(event._id) === target.eventId, "event._id");
	requireCondition(id(mirror._id) === target.mirrorId, "mirror._id");
	requireCondition(
		id(reservation._id) === target.reservationMongoId,
		"reservation._id"
	);
	for (const [role, document] of Object.entries({
		event,
		mirror,
		reservation,
	})) {
		requireCondition(
			id(document.hotelId) === target.hotelId,
			`${role}.hotelId`
		);
	}
	requireCondition(
		clean(event.hotelRunnerReservationId) === target.hotelRunnerReservationId,
		"event.hotelRunnerReservationId"
	);
	requireCondition(
		clean(mirror.hotelRunnerReservationId) === target.hotelRunnerReservationId,
		"mirror.hotelRunnerReservationId"
	);
	requireCondition(clean(event.hrNumber) === target.hrNumber, "event.hrNumber");
	requireCondition(
		clean(mirror.hrNumber) === target.hrNumber,
		"mirror.hrNumber"
	);
	requireCondition(
		clean(event.providerNumber) === target.confirmationNumber,
		"event.providerNumber"
	);
	requireCondition(
		clean(mirror.providerNumber) === target.confirmationNumber,
		"mirror.providerNumber"
	);
	requireCondition(lower(event.channel) === target.provider, "event.channel");
	requireCondition(lower(mirror.channel) === target.provider, "mirror.channel");
	requireCondition(
		event.payloadHash === target.eventPayloadHash,
		"event.payloadHash"
	);
	requireCondition(
		event.canonicalHash === target.eventCanonicalHash,
		"event.canonicalHash"
	);
	requireCondition(
		id(reservation.belongsTo) === target.ownerId,
		"reservation.belongsTo"
	);
	requireCondition(
		lower(reservation.booking_source) === target.provider,
		"reservation.booking_source"
	);
	requireCondition(
		lower(reservation.otaIdentityKey) === target.otaIdentityKey,
		"reservation.otaIdentityKey"
	);
	requireCondition(
		clean(reservation.reservation_id) === target.confirmationNumber,
		"reservation.reservation_id"
	);
	requireCondition(
		clean(reservation.confirmation_number) === target.pmsConfirmationNumber,
		"reservation.confirmation_number"
	);
	requireCondition(
		dateKey(reservation.checkin_date) === target.checkinDate &&
			dateKey(reservation.checkout_date) === target.checkoutDate,
		"reservation.stay"
	);
	requireCondition(
		Number(reservation.total_rooms) === target.totalRooms,
		"reservation.total_rooms"
	);
	requireCondition(
		lower(reservation.currency) === lower(target.propertyCurrency),
		"reservation.currency"
	);
	const rooms = reservation.pickedRoomsType;
	requireCondition(
		Array.isArray(rooms) && rooms.length === 1,
		"reservation.pickedRoomsType"
	);
	requireCondition(Number(rooms[0]?.count) === 1, "reservation.room.count");
	requireCondition(
		rooms[0]?.room_type === target.roomType,
		"reservation.room.room_type"
	);
	requireCondition(
		id(rooms[0]?.hotelRoomConfigId) === target.roomConfigId,
		"reservation.room.hotelRoomConfigId"
	);

	const evidence = reservation.supplierData?.otaCommercialEvidence;
	requireCondition(
		lower(evidence?.provider) === target.provider &&
			lower(evidence?.sourceType) === "authenticated_provider_portal" &&
			lower(evidence?.verificationState) === "verified",
		"reservation.authenticated_provider_portal evidence"
	);
	requireCondition(
		lower(evidence?.sourceCurrency) === lower(target.sourceCurrency) &&
			lower(evidence?.propertyCurrency) === lower(target.propertyCurrency),
		"reservation.commercial currencies"
	);
	requireCondition(
		lower(evidence?.provenance?.primary?.sourceType) ===
			"authenticated_provider_portal" &&
			lower(evidence?.provenance?.primary?.provider) === target.provider,
		"reservation.commercial provenance"
	);
	const gross = evidence?.roles?.guestGross;
	const payout = evidence?.roles?.hotelPayout;
	requireCondition(
		gross?.verified === true &&
			cents(gross.sourceAmount) === cents(target.portalGuestGross) &&
			lower(gross.sourceCurrency) === lower(target.sourceCurrency) &&
			cents(gross.propertyAmount) === cents(target.propertyGuestGross),
		"reservation.portal guest-gross role"
	);
	requireCondition(
		payout?.verified === true &&
			cents(payout.sourceAmount) === cents(target.portalPayout) &&
			lower(payout.sourceCurrency) === lower(target.sourceCurrency) &&
			cents(payout.propertyAmount) === cents(target.propertyPayout) &&
			payout.sourceRef === "primary",
		"reservation.portal hotel-payout role"
	);
	const paymentSummary = reservation.supplierData?.otaPaymentSummary;
	requireCondition(
		cents(paymentSummary?.sourceTotalPayoutAmount) ===
			cents(target.portalPayout) &&
			lower(paymentSummary?.sourceTotalPayoutCurrency) ===
				lower(target.sourceCurrency) &&
			Number(paymentSummary?.exchangeRateToSar) === target.exchangeRate,
		"reservation.portal payout summary"
	);

	const snapshot = mirror.normalizedSnapshot || {};
	requireCondition(
		lower(snapshot.currency) === lower(target.sourceCurrency),
		"mirror.currency"
	);
	requireCondition(
		Number(snapshot.totalCents) === target.portalPayoutCents &&
			Number(snapshot.itemTotalCents) === target.portalPayoutCents &&
			Number(snapshot.subTotalCents) === target.portalPayoutCents,
		"mirror.HotelRunner payout"
	);
	requireCondition(
		dateKey(snapshot.checkinDate) === target.checkinDate &&
			dateKey(snapshot.checkoutDate) === target.checkoutDate,
		"mirror.stay"
	);
	requireCondition(
		Number(snapshot.totalRooms) === target.totalRooms &&
			Array.isArray(snapshot.rooms) &&
			snapshot.rooms.length === 1,
		"mirror.rooms"
	);
	requireCondition(
		clean(snapshot.rooms[0]?.invCode) === target.hotelRunnerInvCode &&
			clean(snapshot.rooms[0]?.roomId) === target.hotelRunnerRoomId &&
			Number(snapshot.rooms[0]?.totalCents) === target.portalPayoutCents,
		"mirror.room identity and payout"
	);
	requireCondition(
		cents(payout.sourceAmount) === Number(snapshot.totalCents),
		"HotelRunner USD 438.40 equals portal hotel-payout role"
	);

	if (requireOriginalHashes) {
		requireCondition(
			canonicalEjsonSha256(event) === target.eventDocumentHash,
			"event full-document hash"
		);
		requireCondition(
			canonicalEjsonSha256(mirror) === target.mirrorDocumentHash,
			"mirror full-document hash"
		);
		requireCondition(
			canonicalEjsonSha256(snapshot) === target.mirrorSnapshotHash,
			"mirror normalized snapshot hash"
		);
		requireCondition(
			canonicalEjsonSha256(reservation) === target.reservationDocumentHash,
			"reservation full-document hash"
		);
		requireCondition(
			evidence?.evidenceHash === target.commercialEvidenceHash &&
				canonicalEjsonSha256(evidence) ===
					target.commercialEvidenceDocumentHash,
			"reservation commercial evidence hash"
		);
		requireCondition(
			canonicalEjsonSha256(rooms) === target.pickedRoomsHash,
			"reservation picked-room hash"
		);
		requireCondition(
			canonicalEjsonSha256(paymentSummary) === target.paymentSummaryHash,
			"reservation payment-summary hash"
		);
	}
	return true;
}

function validateOriginalFailure(scope, target = TARGET) {
	validateIdentityAndEvidence(scope, target, { requireOriginalHashes: true });
	const { event, mirror, reservation } = scope;
	requireCondition(Number(event.__v || 0) === target.eventVersion, "event.__v");
	requireCondition(lower(event.status) === target.eventStatus, "event.status");
	requireCondition(
		Number(event.attempts) === target.eventAttempts,
		"event.attempts"
	);
	requireCondition(
		event.errorCode === target.eventErrorCode,
		"event.errorCode"
	);
	requireCondition(
		event.errorMessage === target.eventErrorMessage,
		"event.errorMessage"
	);
	requireCondition(
		sameDate(event.receivedAt, target.eventReceivedAt),
		"event.receivedAt"
	);
	requireCondition(
		sameDate(event.sourceUpdatedAt, target.eventSourceUpdatedAt),
		"event.sourceUpdatedAt"
	);
	requireCondition(
		sameDate(event.processedAt, target.eventProcessedAt),
		"event.processedAt"
	);
	requireCondition(
		sameDate(event.updatedAt, target.eventUpdatedAt),
		"event.updatedAt"
	);
	requireCondition(!id(event.reservationMongoId), "event.reservationMongoId");
	requireCondition(!id(event.mirrorId), "event.mirrorId");
	requireCondition(
		event.finalRecoveryAttempted === false,
		"event.finalRecoveryAttempted"
	);
	requireCondition(
		!event.finalRecoveryClaimedAt,
		"event.finalRecoveryClaimedAt"
	);
	requireCondition(
		lower(mirror.projectionStatus) === "pending",
		"mirror.projectionStatus"
	);
	requireCondition(
		Number(mirror.projectionVersion) === 0,
		"mirror.projectionVersion"
	);
	requireCondition(!id(mirror.reservationMongoId), "mirror.reservationMongoId");
	requireCondition(!id(reservation.hr_number), "reservation.hr_number");
	return true;
}

function buildEventRequeueUpdate(repairAt) {
	const at = new Date(repairAt);
	return {
		$set: {
			status: "pending",
			attempts: 0,
			nextAttemptAt: at,
			processedAt: null,
			errorCode: "",
			errorMessage: "",
			result: {},
			finalRecoveryAttempted: false,
			finalRecoveryClaimedAt: null,
			updatedAt: at,
		},
		$unset: {
			leaseOwner: "",
			leaseAcquiredAt: "",
			leaseUntil: "",
		},
		$inc: { __v: 1 },
	};
}

function planBasis(scope, repairAt, target = TARGET) {
	const update = buildEventRequeueUpdate(repairAt);
	const expectedEvent = applyUpdateToDocument(scope.event, update);
	return {
		recoveryId: REPAIR_ID,
		repairAt: new Date(repairAt),
		target: {
			eventId: target.eventId,
			mirrorId: target.mirrorId,
			reservationMongoId: target.reservationMongoId,
			provider: target.provider,
			confirmationNumber: target.confirmationNumber,
			hotelRunnerReservationId: target.hotelRunnerReservationId,
		},
		originalEventHash: canonicalEjsonSha256(scope.event),
		mirrorEvidenceHash: canonicalEjsonSha256(scope.mirror),
		reservationEvidenceHash: canonicalEjsonSha256(scope.reservation),
		commercialEvidenceHash:
			scope.reservation.supplierData.otaCommercialEvidence.evidenceHash,
		update,
		expectedEventHash: canonicalEjsonSha256(expectedEvent),
	};
}

function verifyBackup(backup, target = TARGET) {
	requireCondition(Boolean(backup), "durable backup missing");
	requireCondition(backup._id === REPAIR_ID, "backup._id");
	requireCondition(backup.repairId === REPAIR_ID, "backup.repairId");
	requireCondition(id(backup.eventId) === target.eventId, "backup.eventId");
	requireCondition(
		backup.originalEventHash === target.eventDocumentHash,
		"backup.originalEventHash"
	);
	requireCondition(
		canonicalEjsonSha256(backup.originalDocument) === backup.originalEventHash,
		"backup original document hash"
	);
	return true;
}

function classifyAppliedEvent(scope, manifest, target = TARGET) {
	const { event, mirror } = scope;
	const reservationId = id(event.reservationMongoId);
	if (
		lower(event.status) === "completed" &&
		reservationId === target.reservationMongoId &&
		id(event.mirrorId) === target.mirrorId &&
		id(mirror.reservationMongoId) === target.reservationMongoId &&
		["created", "updated"].includes(lower(mirror.projectionStatus))
	) {
		return "converged";
	}
	if (
		["pending", "processing", "retry"].includes(lower(event.status)) &&
		canonicalEjsonSha256(event) === manifest.expectedEventHash
	) {
		return "requeued_pending";
	}
	if (["pending", "processing", "retry"].includes(lower(event.status))) {
		return "replay_in_progress";
	}
	if (lower(event.status) === "failed") return "replay_failed";
	return "applied_state_drift";
}

function verifyManifest(scope, target = TARGET) {
	const { manifest, backup } = scope;
	requireCondition(Boolean(manifest), "manifest missing");
	requireCondition(manifest._id === REPAIR_ID, "manifest._id");
	requireCondition(manifest.state === "applied", "manifest.state");
	requireCondition(id(manifest.eventId) === target.eventId, "manifest.eventId");
	requireCondition(
		manifest.originalEventHash === target.eventDocumentHash,
		"manifest.originalEventHash"
	);
	requireCondition(validSha256(manifest.planHash), "manifest.planHash");
	requireCondition(
		canonicalEjsonSha256(manifest.planBasis) === manifest.planHash,
		"manifest.planBasis"
	);
	verifyBackup(backup, target);
	return true;
}

function buildPlan(scope, repairAt = new Date(), target = TARGET) {
	if (scope.manifest || scope.backup) {
		requireCondition(
			Boolean(scope.manifest) && Boolean(scope.backup),
			"partial backup/manifest state"
		);
		verifyManifest(scope, target);
		validateIdentityAndEvidence(scope, target, {
			requireOriginalHashes: false,
		});
		return {
			state: classifyAppliedEvent(scope, scope.manifest, target),
			repairAt: new Date(scope.manifest.repairAt),
			planHash: scope.manifest.planHash,
			basis: cloneBson(scope.manifest.planBasis),
			scope,
			target,
		};
	}
	validateOriginalFailure(scope, target);
	const basis = planBasis(scope, repairAt, target);
	return {
		state: "ready",
		repairAt: new Date(repairAt),
		planHash: canonicalEjsonSha256(basis),
		basis,
		scope,
		target,
	};
}

function proofToken(plan) {
	return plan.state === "ready"
		? `${plan.repairAt.getTime()}.${plan.planHash}`
		: "";
}

function backupRecord(plan, createdAt) {
	return {
		_id: REPAIR_ID,
		repairId: REPAIR_ID,
		eventId: oid(plan.target.eventId),
		originalEventHash: plan.basis.originalEventHash,
		originalDocument: cloneBson(plan.scope.event),
		evidence: {
			mirrorId: oid(plan.target.mirrorId),
			mirrorHash: plan.basis.mirrorEvidenceHash,
			reservationMongoId: oid(plan.target.reservationMongoId),
			reservationHash: plan.basis.reservationEvidenceHash,
			commercialEvidenceHash: plan.basis.commercialEvidenceHash,
		},
		createdAt: new Date(createdAt),
	};
}

function manifestRecord(plan, appliedAt) {
	return {
		_id: REPAIR_ID,
		repairId: REPAIR_ID,
		state: "applied",
		eventId: oid(plan.target.eventId),
		originalEventHash: plan.basis.originalEventHash,
		expectedEventHash: plan.basis.expectedEventHash,
		planHash: plan.planHash,
		planBasis: cloneBson(plan.basis),
		repairAt: new Date(plan.repairAt),
		appliedAt: new Date(appliedAt),
		backupCollection: BACKUP_COLLECTION,
		mutatedCollection: COLLECTION_NAMES.events,
	};
}

const matchedOne = (result) =>
	Number(result?.matchedCount ?? result?.n ?? 0) === 1 &&
	Number(result?.modifiedCount ?? result?.nModified ?? 0) === 1;

async function applyRecovery({
	collections,
	proof,
	now = new Date(),
	target = TARGET,
	runTransaction = async (work) => work(null),
}) {
	const parsedProof = parseProof(proof, now);
	const preflight = buildPlan(
		await loadScope(collections, null, target),
		parsedProof.plannedAt,
		target
	);
	if (preflight.state !== "ready") {
		if (preflight.planHash !== parsedProof.planHash) {
			fail(
				"The supplied proof does not match the durable applied manifest.",
				"HOTELRUNNER_EXPEDIA_EVENT_RECOVERY_PROOF_MISMATCH"
			);
		}
		return { changed: 0, acknowledgementRecovered: false, plan: preflight };
	}
	if (preflight.planHash !== parsedProof.planHash) {
		fail(
			"The live exact scope does not match the supplied dry-run proof.",
			"HOTELRUNNER_EXPEDIA_EVENT_RECOVERY_PROOF_MISMATCH"
		);
	}

	try {
		await runTransaction(async (session) => {
			const live = buildPlan(
				await loadScope(collections, session, target),
				parsedProof.plannedAt,
				target
			);
			requireCondition(
				live.state === "ready",
				"transaction scope is not ready"
			);
			requireCondition(
				live.planHash === parsedProof.planHash,
				"transaction proof mismatch"
			);
			await collections.backups.insertOne(
				backupRecord(live, now),
				session ? { session } : undefined
			);
			const updateResult = await collections.events.updateOne(
				buildExactCasFilter(live.scope.event),
				live.basis.update,
				session ? { session } : undefined
			);
			if (!matchedOne(updateResult)) {
				fail(
					"The full-document event compare-and-set was lost.",
					"HOTELRUNNER_EXPEDIA_EVENT_RECOVERY_EVENT_CAS_LOST"
				);
			}
			await collections.manifests.insertOne(
				manifestRecord(live, now),
				session ? { session } : undefined
			);
		});
	} catch (error) {
		let observed;
		try {
			observed = buildPlan(
				await loadScope(collections, null, target),
				parsedProof.plannedAt,
				target
			);
		} catch (observationError) {
			error.observationError = observationError;
			throw error;
		}
		if (
			observed.state !== "ready" &&
			observed.planHash === parsedProof.planHash &&
			!["replay_failed", "applied_state_drift"].includes(observed.state)
		) {
			return { changed: 1, acknowledgementRecovered: true, plan: observed };
		}
		throw error;
	}

	const after = buildPlan(
		await loadScope(collections, null, target),
		parsedProof.plannedAt,
		target
	);
	if (["ready", "replay_failed", "applied_state_drift"].includes(after.state)) {
		fail(
			`Event recovery postcondition failed: ${after.state}.`,
			"HOTELRUNNER_EXPEDIA_EVENT_RECOVERY_POSTCONDITION_FAILED"
		);
	}
	return { changed: 1, acknowledgementRecovered: false, plan: after };
}

function sanitizedOutput(plan, mode, extra = {}) {
	return {
		mode,
		repairId: REPAIR_ID,
		state: plan.state,
		proof: mode === "dry_run" ? proofToken(plan) || undefined : undefined,
		proofExpiresInMinutes:
			mode === "dry_run" && plan.state === "ready"
				? PROOF_MAX_AGE_MS / 60_000
				: undefined,
		eventId: plan.target.eventId,
		mirrorId: plan.target.mirrorId,
		reservationMongoId: plan.target.reservationMongoId,
		provider: plan.target.provider,
		confirmationNumber: plan.target.confirmationNumber,
		hotelRunnerReservationId: plan.target.hotelRunnerReservationId,
		commercialMatch: {
			sourceType: "authenticated_provider_portal",
			sourceCurrency: plan.target.sourceCurrency,
			hotelRunnerAmount: plan.target.portalPayout,
			portalRole: "hotelPayout",
			portalRoleAmount: plan.target.portalPayout,
		},
		backupCollection: BACKUP_COLLECTION,
		manifestCollection: MANIFEST_COLLECTION,
		mutates: [COLLECTION_NAMES.events, BACKUP_COLLECTION, MANIFEST_COLLECTION],
		mutatesReservation: false,
		mutatesMirror: false,
		mutatesInboundAudit: false,
		...extra,
	};
}

async function connectDatabase(database) {
	await mongoose.connect(database, {
		autoIndex: false,
		autoCreate: false,
		readPreference: "primary",
	});
}

async function main(
	argv = process.argv.slice(2),
	{
		clock = () => new Date(),
		connect = connectDatabase,
		disconnect = async () => mongoose.disconnect(),
		collections: injectedCollections = null,
		db: injectedDb = null,
		runTransaction: injectedTransaction = null,
		skipConnect = false,
		target = TARGET,
	} = {}
) {
	const options = parseArguments(argv);
	if (options.help) {
		return {
			usage: [
				"node scripts/recoverHotelRunnerExpedia2531071530Event20260810.js",
				`node scripts/recoverHotelRunnerExpedia2531071530Event20260810.js --apply --repair-id=${REPAIR_ID} --proof=<dry-run-proof>`,
			],
		};
	}
	const database =
		process.env.DATABASE || process.env.MONGO_URI || process.env.MONGODB_URI;
	if (!skipConnect && !database) {
		fail(
			"Missing DATABASE/MONGO connection string.",
			"HOTELRUNNER_EXPEDIA_EVENT_RECOVERY_DATABASE_REQUIRED"
		);
	}
	let connectedHere = false;
	try {
		if (!skipConnect) {
			await connect(database);
			connectedHere = true;
		}
		const db = injectedDb || mongoose.connection.db;
		const collections = injectedCollections || collectionsFromDb(db);
		const now = clock();
		if (!options.apply) {
			const plan = buildPlan(
				await loadScope(collections, null, target),
				now,
				target
			);
			return sanitizedOutput(plan, "dry_run");
		}

		const runTransaction =
			injectedTransaction ||
			(async (work) => {
				const session = await mongoose.startSession();
				try {
					let value;
					await session.withTransaction(
						async () => {
							value = await work(session);
						},
						{
							readConcern: { level: "snapshot" },
							writeConcern: { w: "majority" },
						}
					);
					return value;
				} finally {
					await session.endSession();
				}
			});
		const result = await applyRecovery({
			collections,
			proof: options.proof,
			now,
			target,
			runTransaction,
		});
		return sanitizedOutput(result.plan, "apply", {
			changedEvents: result.changed,
			acknowledgementRecovered: result.acknowledgementRecovered,
		});
	} finally {
		if (connectedHere) await disconnect();
	}
}

if (require.main === module) {
	main()
		.then((output) => console.log(JSON.stringify(output, null, 2)))
		.catch((error) => {
			console.error(
				JSON.stringify(
					{
						ok: false,
						code:
							error?.code || "HOTELRUNNER_EXPEDIA_EVENT_RECOVERY_UNEXPECTED",
						message: error?.message || "Recovery failed.",
					},
					null,
					2
				)
			);
			process.exitCode = 1;
		});
}

module.exports = {
	BACKUP_COLLECTION,
	CLOCK_SKEW_MS,
	COLLECTION_NAMES,
	MANIFEST_COLLECTION,
	PROOF_MAX_AGE_MS,
	REPAIR_ID,
	TARGET,
	RecoveryError,
	applyRecovery,
	backupRecord,
	buildEventRequeueUpdate,
	buildPlan,
	classifyAppliedEvent,
	collectionsFromDb,
	loadScope,
	main,
	manifestRecord,
	parseArguments,
	parseProof,
	planBasis,
	proofToken,
	sanitizedOutput,
	validateIdentityAndEvidence,
	validateOriginalFailure,
	verifyBackup,
	verifyManifest,
};
