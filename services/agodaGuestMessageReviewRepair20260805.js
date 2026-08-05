/**
 * Pure planning and verification helpers for restoring the workflow state of
 * one Agoda reservation that was incorrectly staged by a guest fee-waiver
 * message on 2026-08-05.
 *
 * This module performs no database I/O. The companion maintenance script is
 * dry-run-only unless the operator supplies every apply interlock.
 */

"use strict";

const assert = require("node:assert/strict");
const {
	applyUpdateToDocument,
	buildExactCasFilter,
	canonicalEjsonSha256,
	canonicalEqual,
	cloneBson,
} = require("./tripHotelRunnerRepair20260805");

const OPERATION = "agoda_guest_message_review_state_repair_20260805";
const MANIFEST_COLLECTION = "ota_agoda_message_repair_manifests";
const BACKUP_COLLECTION_PREFIX = "ota_agoda_message_repair_backup_";
const REPAIR_ACTION = "restore-after-misclassified-agoda-guest-message";

const TARGET = Object.freeze({
	mongoId: "6a716d6c931158c859f37887",
	pmsConfirmation: "4459636269",
	otaConfirmation: "685912279",
	otaIdentityKey: "agoda:685912279",
	hotelId: "6a40b6a1a6efe70450536038",
	roomType: "tripleRooms",
	roomConfigId: "6a40e0981a6d1850eb25c27c",
	checkinDate: "2026-08-14",
	checkoutDate: "2026-08-17",
	guestTotalSar: 226.38,
	hotelBaseTotalSar: 225,
	payoutSar: 140.07,
	incidentUpdatedAt: "2026-08-05T06:54:06.043Z",
	incidentVersion: 3,
	releasedAt: "2026-08-04T04:58:54.098Z",
	confirmedAt: "2026-08-04T04:59:10.146Z",
	originalInboundId: "6a716d5c931158c859f37873",
	originalInboundProcessedAt: "2026-08-04T04:41:16.430Z",
	hotelRunnerDuplicateInboundId: "6a7182a5931158c859f38eae",
	offendingInboundId: "6a72ddcffb0c149d5540ea4b",
	offendingDuplicateInboundId: "6a72de29fb0c149d5540eaa8",
});

const AUDITS = Object.freeze([
	Object.freeze({
		id: TARGET.originalInboundId,
		role: "original_agoda_confirmation",
		provider: "agoda",
		automationAction: "created",
		skipReason: "",
		emailHash: "78ed3f7a0fdee51c7d3f49e705d4a6ab7af1e79a392c6fe50b14d436e14871e6",
		textHash: "248daf5162bacefdbc56f7c9d90c246d9ede037ff7cdac7e7afa9db3b22495d7",
		receivedAt: "2026-08-04T04:41:00.610Z",
		processedAt: TARGET.originalInboundProcessedAt,
		duplicateOf: "",
	}),
	Object.freeze({
		id: TARGET.hotelRunnerDuplicateInboundId,
		role: "hotelrunner_duplicate_no_mutation",
		provider: "agoda",
		automationAction: "skipped",
		skipReason: "duplicate_existing_reservation_no_update",
		emailHash: "cb0943297f783d8130e317a2d7aec7db93f00d5303fdfd355ac9f689dc5943e6",
		textHash: "58ed2164ee969fbfdb154573bc42db737b365f371f6ed0ec9e3544f6530f9df2",
		receivedAt: "2026-08-04T06:11:49.208Z",
		processedAt: "2026-08-04T06:12:03.939Z",
		duplicateOf: "",
	}),
	Object.freeze({
		id: TARGET.offendingInboundId,
		role: "misclassified_agoda_guest_fee_waiver_message",
		provider: "agoda",
		automationAction: "updated",
		skipReason: "",
		emailHash: "489c1a3803132f1306e80d1bd6ad14325a64408c7f63debaa86c561870110e1e",
		textHash: "93632bc28102004fcee5ce7b5364b2d7cbb3a1719902ac33a5dd0f5b806519f4",
		receivedAt: "2026-08-05T06:53:03.191Z",
		processedAt: "2026-08-05T06:54:06.055Z",
		duplicateOf: "",
	}),
	Object.freeze({
		id: TARGET.offendingDuplicateInboundId,
		role: "duplicate_of_misclassified_message",
		provider: "agoda",
		automationAction: "skipped",
		skipReason: "duplicate_email",
		emailHash: "489c1a3803132f1306e80d1bd6ad14325a64408c7f63debaa86c561870110e1e",
		textHash: "93632bc28102004fcee5ce7b5364b2d7cbb3a1719902ac33a5dd0f5b806519f4",
		receivedAt: "2026-08-05T06:54:33.177Z",
		processedAt: "2026-08-05T06:54:33.190Z",
		duplicateOf: TARGET.offendingInboundId,
	}),
]);

const ALL_AUDIT_IDS = Object.freeze(AUDITS.map((audit) => audit.id));
const id = (value) => String(value?._id || value || "");
const dateIso = (value) => {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? "" : date.toISOString();
};
const dateKey = (value) => dateIso(value).slice(0, 10);
const cents = (value) => Math.round(Number(value || 0) * 100);
const assertEqual = (actual, expected, label) =>
	assert.equal(actual, expected, `${label}: expected ${expected}, received ${actual}`);
const assertDate = (actual, expected, label) =>
	assertEqual(dateIso(actual), expected, label);
const assertMoney = (actual, expected, label) =>
	assertEqual(cents(actual), cents(expected), label);

const deletePath = (object, path) => {
	const keys = String(path).split(".");
	let current = object;
	for (let index = 0; index < keys.length - 1; index += 1) {
		current = current?.[keys[index]];
		if (!current || typeof current !== "object") return;
	}
	delete current[keys[keys.length - 1]];
};

const mutableRepairPaths = Object.freeze([
	"state",
	"reservation_status",
	"updatedAt",
	"__v",
	"adminPricingVisibility",
	"reservationAuditLog",
	"otaPlatformReview.status",
	"otaPlatformReview.source",
	"otaPlatformReview.inboundEmailId",
	"otaPlatformReview.lastUpdatedAt",
	"otaPlatformReview.proposedInbound",
	"supplierData.otaLastInboundEmailId",
	"supplierData.otaLastEmailAt",
	"supplierData.otaLastEventType",
]);

const immutableRepairSnapshot = (reservation) => {
	const snapshot = cloneBson(reservation);
	mutableRepairPaths.forEach((path) => deletePath(snapshot, path));
	return snapshot;
};

const validateCurrentReservation = (reservation) => {
	assert.ok(reservation, "The exact Agoda target reservation was not found.");
	assertEqual(id(reservation), TARGET.mongoId, "reservation _id");
	assertEqual(
		String(reservation.confirmation_number || ""),
		TARGET.pmsConfirmation,
		"PMS confirmation",
	);
	assertEqual(
		String(reservation.reservation_id || ""),
		TARGET.otaConfirmation,
		"OTA confirmation",
	);
	assertEqual(
		String(reservation.otaIdentityKey || ""),
		TARGET.otaIdentityKey,
		"canonical OTA identity",
	);
	assertEqual(id(reservation.hotelId), TARGET.hotelId, "hotelId");
	assertEqual(dateKey(reservation.checkin_date), TARGET.checkinDate, "check-in date");
	assertEqual(dateKey(reservation.checkout_date), TARGET.checkoutDate, "check-out date");
	assertMoney(reservation.total_amount, TARGET.guestTotalSar, "guest total SAR");
	assertMoney(reservation.sub_total, TARGET.hotelBaseTotalSar, "hotel base total SAR");
	assertMoney(
		reservation.supplierData?.otaTotalPayoutSar,
		TARGET.payoutSar,
		"Agoda payout SAR",
	);

	assert.equal(
		Array.isArray(reservation.pickedRoomsType),
		true,
		"pickedRoomsType must be an array.",
	);
	assertEqual(reservation.pickedRoomsType.length, 1, "room row count");
	assertEqual(
		String(reservation.pickedRoomsType[0]?.room_type || ""),
		TARGET.roomType,
		"room semantic type",
	);
	assertEqual(
		id(reservation.pickedRoomsType[0]?.hotelRoomConfigId),
		TARGET.roomConfigId,
		"room config ID",
	);

	assertEqual(String(reservation.state || ""), "ota platform review", "incident state");
	assertEqual(
		String(reservation.reservation_status || ""),
		"ota platform review",
		"incident reservation_status",
	);
	assertEqual(Number(reservation.__v), TARGET.incidentVersion, "incident __v");
	assertDate(reservation.updatedAt, TARGET.incidentUpdatedAt, "incident updatedAt");
	assertEqual(
		String(reservation.pendingConfirmation?.status || ""),
		"confirmed",
		"admin-confirmed pending status",
	);
	assertDate(
		reservation.pendingConfirmation?.confirmedAt,
		TARGET.confirmedAt,
		"admin confirmation timestamp",
	);
	assertEqual(
		String(reservation.agentDecisionSnapshot?.status || ""),
		"confirmed",
		"admin decision status",
	);

	assertEqual(
		String(reservation.otaPlatformReview?.status || ""),
		"pending",
		"incident review status",
	);
	assertEqual(
		String(reservation.otaPlatformReview?.source || ""),
		"ota_email_update",
		"incident review source",
	);
	assertEqual(
		id(reservation.otaPlatformReview?.inboundEmailId),
		TARGET.offendingInboundId,
		"incident review inbound link",
	);
	assertEqual(
		id(reservation.otaPlatformReview?.proposedInbound?.inboundEmailId),
		TARGET.offendingInboundId,
		"incident proposedInbound link",
	);
	assertDate(
		reservation.otaPlatformReview?.releasedAt,
		TARGET.releasedAt,
		"original release timestamp",
	);
	assert.ok(
		reservation.otaPlatformReview?.releasedBy?._id,
		"Original releasedBy evidence is required.",
	);
	assertEqual(
		String(reservation.adminPricingVisibility?.source || ""),
		"ota_email_update",
		"incident pricing visibility source",
	);
	assertEqual(
		id(reservation.supplierData?.otaLastInboundEmailId),
		TARGET.offendingInboundId,
		"incident supplier inbound link",
	);
	assertEqual(
		String(reservation.supplierData?.otaLastEventType || ""),
		"modified",
		"incident supplier event type",
	);

	const auditLog = reservation.reservationAuditLog;
	assert.ok(Array.isArray(auditLog) && auditLog.length > 0, "Reservation audit log is required.");
	const lastAudit = auditLog[auditLog.length - 1];
	assertEqual(
		String(lastAudit?.action || ""),
		"updated-existing-partial-from-email",
		"incident reservation audit action",
	);
	assertEqual(
		String(lastAudit?.messageId || ""),
		"<87234350ece56b404b09ee28e5742951/d0264f0bb762fd2b410f3e416cac71b1@agoda-messaging.com>",
		"incident message ID",
	);
	return true;
};

const validateAuditSet = (audits) => {
	assert.ok(Array.isArray(audits), "Inbound evidence audits must be an array.");
	assertEqual(audits.length, AUDITS.length, "exact inbound evidence count");
	const byId = new Map(audits.map((audit) => [id(audit), audit]));
	assertEqual(byId.size, AUDITS.length, "unique inbound evidence count");
	for (const expected of AUDITS) {
		const audit = byId.get(expected.id);
		assert.ok(audit, `Missing inbound evidence ${expected.id} (${expected.role}).`);
		assertEqual(String(audit.provider || ""), expected.provider, `${expected.role} provider`);
		assertEqual(
			String(audit.automationAction || ""),
			expected.automationAction,
			`${expected.role} action`,
		);
		assertEqual(
			String(audit.skipReason || ""),
			expected.skipReason,
			`${expected.role} skipReason`,
		);
		assertEqual(String(audit.emailHash || ""), expected.emailHash, `${expected.role} emailHash`);
		assertEqual(String(audit.textHash || ""), expected.textHash, `${expected.role} textHash`);
		assertDate(audit.receivedAt, expected.receivedAt, `${expected.role} receivedAt`);
		assertDate(audit.processedAt, expected.processedAt, `${expected.role} processedAt`);
		assertEqual(
			id(audit.duplicateOf),
			expected.duplicateOf,
			`${expected.role} duplicateOf`,
		);
		assertEqual(
			String(audit.confirmationNumber || ""),
			TARGET.otaConfirmation,
			`${expected.role} OTA confirmation`,
		);
		assertEqual(
			String(audit.pmsConfirmationNumber || ""),
			TARGET.pmsConfirmation,
			`${expected.role} PMS confirmation`,
		);
		assertEqual(id(audit.reservationMongoId), TARGET.mongoId, `${expected.role} reservation link`);
	}
	return true;
};

const buildRepairUpdate = (reservation, context) => {
	assert.ok(context && typeof context === "object", "Repair context is required.");
	assert.ok(String(context.repairId || "").trim(), "repairId is required.");
	assert.ok(String(context.backupCollection || "").trim(), "backupCollection is required.");
	assert.ok(dateIso(context.repairAt), "repairAt must be a valid date.");
	const releaseActorId = reservation.otaPlatformReview.releasedBy._id;
	return {
		$set: {
			state: "confirmed",
			reservation_status: "confirmed",
			"otaPlatformReview.status": "released",
			"otaPlatformReview.source": "ota_email",
			"otaPlatformReview.inboundEmailId": TARGET.originalInboundId,
			adminPricingVisibility: {
				rootOnlyForHotelManagement: true,
				source: "ota_platform_release",
				appliedAt: new Date(TARGET.releasedAt),
				appliedBy: cloneBson(releaseActorId),
			},
			"supplierData.otaLastInboundEmailId": TARGET.originalInboundId,
			"supplierData.otaLastEmailAt": new Date(TARGET.originalInboundProcessedAt),
			"supplierData.otaLastEventType": "new",
			updatedAt: new Date(context.repairAt),
		},
		$unset: {
			"otaPlatformReview.lastUpdatedAt": "",
			"otaPlatformReview.proposedInbound": "",
		},
		$inc: { __v: 1 },
		$push: {
			reservationAuditLog: {
				at: new Date(context.repairAt),
				source: "maintenance-repair",
				action: REPAIR_ACTION,
				repairId: context.repairId,
				backupCollection: context.backupCollection,
				evidenceAuditIds: [...ALL_AUDIT_IDS],
				from: {
					state: "ota platform review",
					reservation_status: "ota platform review",
					otaPlatformReviewStatus: "pending",
					inboundEmailId: TARGET.offendingInboundId,
				},
				to: {
					state: "confirmed",
					reservation_status: "confirmed",
					otaPlatformReviewStatus: "released",
					inboundEmailId: TARGET.originalInboundId,
				},
			},
		},
	};
};

const verifyRepairedDocument = ({ before, after, context }) => {
	validateCurrentReservation(before);
	assert.ok(after, "Repaired reservation is required.");
	assertEqual(id(after), TARGET.mongoId, "repaired reservation _id");
	assertEqual(String(after.state || ""), "confirmed", "repaired state");
	assertEqual(
		String(after.reservation_status || ""),
		"confirmed",
		"repaired reservation_status",
	);
	assertEqual(Number(after.__v), TARGET.incidentVersion + 1, "repaired __v");
	assertDate(after.updatedAt, dateIso(context.repairAt), "repaired updatedAt");
	assertEqual(
		String(after.otaPlatformReview?.status || ""),
		"released",
		"repaired review status",
	);
	assertEqual(
		String(after.otaPlatformReview?.source || ""),
		"ota_email",
		"repaired review source",
	);
	assertEqual(
		id(after.otaPlatformReview?.inboundEmailId),
		TARGET.originalInboundId,
		"repaired review inbound link",
	);
	assert.equal(
		Object.prototype.hasOwnProperty.call(after.otaPlatformReview || {}, "proposedInbound"),
		false,
		"Offending proposedInbound must be removed.",
	);
	assert.equal(
		Object.prototype.hasOwnProperty.call(after.otaPlatformReview || {}, "lastUpdatedAt"),
		false,
		"Incident-only review lastUpdatedAt must be removed.",
	);
	assertDate(after.otaPlatformReview?.releasedAt, TARGET.releasedAt, "preserved release timestamp");
	assertEqual(
		String(after.pendingConfirmation?.status || ""),
		"confirmed",
		"preserved admin-confirmed pending status",
	);
	assertEqual(
		String(after.agentDecisionSnapshot?.status || ""),
		"confirmed",
		"preserved admin decision",
	);
	assertEqual(
		String(after.adminPricingVisibility?.source || ""),
		"ota_platform_release",
		"restored pricing visibility source",
	);
	assertDate(
		after.adminPricingVisibility?.appliedAt,
		TARGET.releasedAt,
		"restored pricing visibility timestamp",
	);
	assertEqual(
		id(after.supplierData?.otaLastInboundEmailId),
		TARGET.originalInboundId,
		"restored supplier inbound link",
	);
	assertDate(
		after.supplierData?.otaLastEmailAt,
		TARGET.originalInboundProcessedAt,
		"restored supplier inbound timestamp",
	);
	assertEqual(
		String(after.supplierData?.otaLastEventType || ""),
		"new",
		"restored supplier event type",
	);

	assert.ok(
		canonicalEqual(immutableRepairSnapshot(before), immutableRepairSnapshot(after)),
		"A field outside the explicitly allowed workflow-repair paths changed.",
	);
	const auditLog = after.reservationAuditLog;
	assertEqual(
		auditLog.length,
		before.reservationAuditLog.length + 1,
		"repair audit log length",
	);
	const lastAudit = auditLog[auditLog.length - 1];
	assertEqual(String(lastAudit.action || ""), REPAIR_ACTION, "repair audit action");
	assertEqual(String(lastAudit.repairId || ""), context.repairId, "repair audit repairId");
	assertEqual(
		String(lastAudit.backupCollection || ""),
		context.backupCollection,
		"repair audit backup collection",
	);
	assert.deepEqual(lastAudit.evidenceAuditIds, [...ALL_AUDIT_IDS]);
	return true;
};

const buildRepairPlan = ({ reservation, audits, context }) => {
	validateCurrentReservation(reservation);
	validateAuditSet(audits);
	const update = buildRepairUpdate(reservation, context);
	const expectedDocument = applyUpdateToDocument(reservation, update);
	verifyRepairedDocument({ before: reservation, after: expectedDocument, context });
	return {
		originalDocument: cloneBson(reservation),
		originalHash: canonicalEjsonSha256(reservation),
		casFilter: buildExactCasFilter(reservation),
		casFilterHash: canonicalEjsonSha256(buildExactCasFilter(reservation)),
		update,
		expectedDocument,
		expectedHash: canonicalEjsonSha256(expectedDocument),
		auditHashes: Object.fromEntries(
			audits.map((audit) => [id(audit), canonicalEjsonSha256(audit)]),
		),
	};
};

const validateRepairId = (repairId) => {
	const value = String(repairId || "").trim();
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{7,79}$/.test(value)) {
		throw new Error(
			"--repair-id must be 8-80 characters using only letters, digits, dot, underscore, or hyphen.",
		);
	}
	return value;
};

const buildBackupCollectionName = (repairId) =>
	`${BACKUP_COLLECTION_PREFIX}${validateRepairId(repairId).toLowerCase()}`;

module.exports = {
	ALL_AUDIT_IDS,
	AUDITS,
	BACKUP_COLLECTION_PREFIX,
	MANIFEST_COLLECTION,
	OPERATION,
	REPAIR_ACTION,
	TARGET,
	buildBackupCollectionName,
	buildRepairPlan,
	immutableRepairSnapshot,
	validateAuditSet,
	validateCurrentReservation,
	validateRepairId,
	verifyRepairedDocument,
};
