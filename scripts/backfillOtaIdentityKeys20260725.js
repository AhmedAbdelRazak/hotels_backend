/** @format */

"use strict";

require("dotenv").config();

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const mongoose = require("mongoose");

const InboundEmail = require("../models/inbound_email");
const Reservations = require("../models/reservations");
const {
	PROVIDER_LABELS,
	buildReservationDocument,
	buildOtaIdentityKey,
	extractNormalizedReservation,
	findReservationByOtaConfirmation,
	normalizeComparable,
	normalizeConfirmation,
	requiredNewReservationMissing,
	resolveHotel,
	resolveRoomMatch,
} = require("../services/otaReservationMapper");

const APPLY = process.argv.includes("--apply");
const PROVIDERS = Object.keys(PROVIDER_LABELS).filter(
	(provider) => !["ota", "hotelrunner"].includes(provider)
);
const SYSTEM_ACTOR = {
	name: "OTA identity backfill 2026-07-25",
	email: "system@jannatbooking.com",
	role: "system",
};

const id = (value) => String(value?._id || value || "");

function emailFromAudit(audit) {
	return {
		from: audit.from || "",
		to: audit.to || "",
		cc: audit.cc || "",
		bcc: audit.bcc || "",
		subject: audit.subject || "",
		text: audit.bodyText || "",
		html: audit.bodyHtml || "",
		messageId: audit.messageId || "",
		date: audit.receivedAt,
		receivedAt: audit.receivedAt,
	};
}

function normalizedProvider(value = "") {
	return normalizeComparable(value).replace(/\s+/g, "");
}

function plausibleProviderConfirmation(provider, confirmationNumber) {
	const value = normalizeConfirmation(confirmationNumber);
	if (!value || value.length < 6 || value.length > 30) return false;
	if (["agoda", "expedia"].includes(provider)) return /^\d{8,18}$/.test(value);
	if (provider === "airbnb") return /^hm[a-z0-9]{6,20}$/i.test(value);
	return /^[a-z0-9][a-z0-9-]{5,29}$/i.test(value);
}

function reservationProviderValues(reservation = {}) {
	return new Set(
		[
			reservation.supplierData?.otaProvider,
			reservation.otaPlatformReview?.provider,
			reservation.supplierData?.supplierName,
			reservation.booking_source,
			reservation.customer_details?.booking_source,
		]
			.map(normalizedProvider)
			.filter(Boolean)
	);
}

function reservationConfirmationValues(reservation = {}) {
	return new Set(
		[
			reservation.reservation_id,
			reservation.customer_details?.confirmation_number2,
			reservation.supplierData?.suppliedBookingNo,
			reservation.supplierData?.otaConfirmationNumber,
			reservation.supplierData?.platformConfirmationNumber,
		]
			.map(normalizeConfirmation)
			.filter(Boolean)
	);
}

function evidenceMatchesReservation(evidence, reservation) {
	const provider = normalizedProvider(evidence.provider);
	const providerLabel = normalizedProvider(PROVIDER_LABELS[evidence.provider] || "");
	return (
		reservationConfirmationValues(reservation).has(evidence.confirmationNumber) &&
		([...reservationProviderValues(reservation)].includes(provider) ||
			[...reservationProviderValues(reservation)].includes(providerLabel))
	);
}

function createSnapshotPath(stage) {
	const directory = path.resolve(
		process.env.OTA_INCIDENT_BACKUP_DIR ||
			path.join(process.cwd(), "..", "deploy-backups")
	);
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	return path.join(directory, `ota-identity-20260725-${stamp}-${stage}.json`);
}

function writeSnapshot(stage, payload) {
	const target = createSnapshotPath(stage);
	fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, {
		encoding: "utf8",
		flag: "wx",
		mode: 0o600,
	});
	return target;
}

async function main() {
	const database =
		process.env.DATABASE || process.env.MONGO_URI || process.env.MONGODB_URI;
	if (!database) throw new Error("Missing DATABASE/MONGO connection string.");
	await mongoose.connect(database, { autoIndex: false });

	const indexes = await Reservations.collection.indexes();
	const uniqueIdentityIndex = indexes.find(
		(index) => index.name === "uniq_ota_identity_key" && index.unique === true
	);
	assert.ok(uniqueIdentityIndex, "Unique OTA identity index is not present.");

	const audits = await InboundEmail.find({
		hasReservationConnection: true,
		reservationMongoId: { $ne: null },
		provider: { $in: PROVIDERS },
		confirmationNumber: { $type: "string", $ne: "" },
	})
		.select(
			"_id provider confirmationNumber reservationMongoId receivedAt from to cc bcc subject bodyText bodyHtml messageId processingStatus"
		)
		.sort({ receivedAt: 1, _id: 1 })
		.lean();

	const evidenceByReservation = new Map();
	const invalidAuditEvidence = [];
	for (const audit of audits) {
		const reservationId = id(audit.reservationMongoId);
		const confirmationNumber = normalizeConfirmation(audit.confirmationNumber);
		const otaIdentityKey = buildOtaIdentityKey(audit.provider, confirmationNumber);
		if (!reservationId || !otaIdentityKey) continue;
		if (!plausibleProviderConfirmation(audit.provider, confirmationNumber)) {
			const current = extractNormalizedReservation(emailFromAudit(audit));
			invalidAuditEvidence.push({
				auditId: id(audit._id),
				reservationId,
				provider: audit.provider,
				confirmationNumber,
				currentParse: {
					provider: current.provider || "",
					intent: current.intent || "",
					eventType: current.eventType || "",
					confirmationNumber: current.confirmationNumber || "",
					missing: requiredNewReservationMissing(current),
				},
			});
			continue;
		}
		const current = evidenceByReservation.get(reservationId) || {
			auditIds: [],
			auditDocuments: [],
			evidence: [],
			identityKeys: new Set(),
		};
		current.auditIds.push(id(audit._id));
		current.auditDocuments.push(audit);
		current.evidence.push({
			provider: audit.provider,
			confirmationNumber,
			otaIdentityKey,
		});
		current.identityKeys.add(otaIdentityKey);
		evidenceByReservation.set(reservationId, current);
	}

	const reservationIds = [...evidenceByReservation.keys()];
	const reservations = await Reservations.find({ _id: { $in: reservationIds } })
		.select(
			"_id __v otaIdentityKey reservation_id confirmation_number booking_source customer_details supplierData otaPlatformReview reservation_status state currency total_amount sub_total"
		)
		.lean();
	const reservationsById = new Map(
		reservations.map((reservation) => [id(reservation._id), reservation])
	);

	const conflicts = [];
	const staleLinks = [];
	const alreadyProtected = [];
	const preliminary = [];
	for (const [reservationId, evidenceGroup] of evidenceByReservation) {
		const reservation = reservationsById.get(reservationId);
		const identityKeys = [...evidenceGroup.identityKeys];
		if (!reservation) {
			staleLinks.push({
				reservationId,
				reason: "linked reservation is missing",
				identityKeys,
				audits: evidenceGroup.auditDocuments.map((audit) => {
					const current = extractNormalizedReservation(emailFromAudit(audit));
					return {
						auditId: id(audit._id),
						receivedAt: audit.receivedAt,
						processingStatus: audit.processingStatus || "",
						currentParse: {
							provider: current.provider || "",
							intent: current.intent || "",
							eventType: current.eventType || "",
							confirmationNumber: current.confirmationNumber || "",
							guestName: current.guestName || "",
							hotelName: current.hotelName || "",
							roomName: current.roomName || "",
							checkinDate: current.checkinDate || "",
							checkoutDate: current.checkoutDate || "",
							sourceAmount: current.sourceAmount || current.amount || 0,
							sourceCurrency: current.sourceCurrency || current.currency || "",
							totalAmountSar: current.totalAmountSar || 0,
							missing: requiredNewReservationMissing(current),
						},
					};
				}),
			});
			continue;
		}
		if (identityKeys.length !== 1) {
			conflicts.push({
				reservationId,
				reason: "linked audits disagree on OTA identity",
				identityKeys,
			});
			continue;
		}
		const otaIdentityKey = identityKeys[0];
		const matchingEvidence = evidenceGroup.evidence.filter((evidence) =>
			evidenceMatchesReservation(evidence, reservation)
		);
		if (!matchingEvidence.length) {
			conflicts.push({
				reservationId,
				otaIdentityKey,
				reason: "reservation provider/confirmation does not match linked audit",
			});
			continue;
		}
		if (reservation.otaIdentityKey) {
			if (String(reservation.otaIdentityKey).toLowerCase() === otaIdentityKey) {
				alreadyProtected.push({ reservationId, otaIdentityKey });
			} else if (
				!String(reservation.otaIdentityKey).includes(":") &&
				matchingEvidence.some(
					(evidence) =>
						normalizeConfirmation(reservation.otaIdentityKey) ===
						evidence.confirmationNumber
				)
			) {
				preliminary.push({
					reservation,
					reservationId,
					otaIdentityKey,
					previousIdentityKey: reservation.otaIdentityKey,
					auditIds: evidenceGroup.auditIds,
				});
			} else {
				conflicts.push({
					reservationId,
					otaIdentityKey,
					reason: `reservation already has ${reservation.otaIdentityKey}`,
				});
			}
			continue;
		}
		preliminary.push({
			reservation,
			reservationId,
			otaIdentityKey,
			previousIdentityKey: "",
			auditIds: evidenceGroup.auditIds,
		});
	}

	const candidatesByIdentity = new Map();
	for (const candidate of preliminary) {
		const current = candidatesByIdentity.get(candidate.otaIdentityKey) || [];
		current.push(candidate);
		candidatesByIdentity.set(candidate.otaIdentityKey, current);
	}
	const duplicateCandidateKeys = new Set();
	for (const [otaIdentityKey, candidates] of candidatesByIdentity) {
		if (candidates.length <= 1) continue;
		duplicateCandidateKeys.add(otaIdentityKey);
		conflicts.push({
			otaIdentityKey,
			reason: "multiple legacy reservations claim one OTA identity",
			reservationIds: candidates.map((candidate) => candidate.reservationId),
		});
	}

	const candidateKeys = [...candidatesByIdentity.keys()].filter(
		(key) => !duplicateCandidateKeys.has(key)
	);
	const existingOwners = candidateKeys.length
		? await Reservations.find({ otaIdentityKey: { $in: candidateKeys } })
				.select("_id otaIdentityKey")
				.lean()
		: [];
	const existingOwnerByKey = new Map(
		existingOwners.map((reservation) => [
			String(reservation.otaIdentityKey).toLowerCase(),
			id(reservation._id),
		])
	);
	const candidates = preliminary.filter((candidate) => {
		if (duplicateCandidateKeys.has(candidate.otaIdentityKey)) return false;
		const existingOwner = existingOwnerByKey.get(candidate.otaIdentityKey);
		if (!existingOwner || existingOwner === candidate.reservationId) return true;
		conflicts.push({
			otaIdentityKey: candidate.otaIdentityKey,
			reservationId: candidate.reservationId,
			reason: `identity already belongs to reservation ${existingOwner}`,
		});
		return false;
	});
	const invalidReservationIds = Array.from(
		new Set(invalidAuditEvidence.map((evidence) => evidence.reservationId).filter(Boolean))
	);
	const invalidLinkedReservations = invalidReservationIds.length
		? await Reservations.find({ _id: { $in: invalidReservationIds } })
				.select(
					"_id otaIdentityKey reservation_id confirmation_number booking_source customer_details.name supplierData.otaProvider supplierData.otaConfirmationNumber hotelId state reservation_status checkin_date checkout_date total_amount currency total_rooms total_guests createdAt updatedAt"
				)
				.lean()
		: [];
	const auditsById = new Map(audits.map((audit) => [id(audit._id), audit]));
	const staleLinkAssessments = [];
	for (const staleLink of staleLinks) {
		const sourceAudit = staleLink.audits
			.map((summary) => auditsById.get(summary.auditId))
			.filter(Boolean)
			.map((audit) => ({
				audit,
				normalized: extractNormalizedReservation(emailFromAudit(audit)),
			}))
			.find(
				(entry) =>
					entry.normalized.intent === "new_reservation" &&
					entry.normalized.eventType === "new" &&
					requiredNewReservationMissing(entry.normalized).length === 0
			);
		if (!sourceAudit) {
			staleLinkAssessments.push({
				reservationId: staleLink.reservationId,
				status: "not_recoverable_from_source",
			});
			continue;
		}
		const normalized = sourceAudit.normalized;
		const existing = await findReservationByOtaConfirmation(
			normalized.confirmationNumber,
			normalized.provider
		);
		if (existing) {
			staleLinkAssessments.push({
				reservationId: staleLink.reservationId,
				status: "identity_already_stored",
				existingReservationId: id(existing._id),
				otaIdentityKey: existing.otaIdentityKey || "",
			});
			continue;
		}
		const hotel = await resolveHotel(normalized);
		const roomMatch = hotel
			? resolveRoomMatch(hotel, normalized.roomName, {
					totalGuests: normalized.totalGuests,
					normalized,
			  })
			: {};
		const built = hotel
			? buildReservationDocument(normalized, hotel, { roomMatch })
			: { ok: false, error: "hotel did not resolve" };
		staleLinkAssessments.push({
			reservationId: staleLink.reservationId,
			status:
				hotel && roomMatch.roomDetails && built.ok
					? "source_complete_and_deterministically_mappable"
					: "source_complete_but_mapping_incomplete",
			auditId: id(sourceAudit.audit._id),
			otaIdentityKey: buildOtaIdentityKey(
				normalized.provider,
				normalized.confirmationNumber
			),
			hotelId: id(hotel?._id),
			hotelName: hotel?.hotelName || hotel?.hotelName_OtherLanguage || "",
			roomId: id(roomMatch.roomDetails?._id),
			roomName: roomMatch.roomDetails?.displayName || "",
			roomMatchType: roomMatch.matchType || "",
			buildOk: built.ok === true,
			buildError: built.error || "",
		});
	}

	const report = {
		mode: APPLY ? "apply" : "dry-run",
		uniqueIdentityIndex: uniqueIdentityIndex.name,
		linkedAuditCount: audits.length,
		linkedReservationCount: evidenceByReservation.size,
		invalidAuditEvidenceCount: invalidAuditEvidence.length,
		invalidAuditEvidence,
		invalidLinkedReservationCount: invalidLinkedReservations.length,
		invalidLinkedReservations,
		staleLinkCount: staleLinks.length,
		staleLinks,
		staleLinkAssessments,
		alreadyProtectedCount: alreadyProtected.length,
		candidateCount: candidates.length,
		conflictCount: conflicts.length,
		conflicts,
		candidates: candidates.map((candidate) => ({
			reservationId: candidate.reservationId,
			previousIdentityKey: candidate.previousIdentityKey,
			otaIdentityKey: candidate.otaIdentityKey,
			auditIds: candidate.auditIds,
		})),
	};
	console.log(JSON.stringify(report, null, 2));

	if (!APPLY) return;
	assert.equal(conflicts.length, 0, "Conflicts found; refusing all identity writes.");
	if (!candidates.length) return;

	const beforeSnapshot = writeSnapshot("before", {
		createdAt: new Date(),
		report,
		reservations: candidates.map((candidate) => candidate.reservation),
	});
	console.log(`Before snapshot: ${beforeSnapshot}`);

	const operations = candidates.map((candidate) => {
		const identityFilter = candidate.previousIdentityKey
			? { otaIdentityKey: candidate.previousIdentityKey }
			: {
					$or: [
						{ otaIdentityKey: { $exists: false } },
						{ otaIdentityKey: null },
						{ otaIdentityKey: "" },
					],
			  };
		return {
			updateOne: {
				filter: {
					_id: candidate.reservation._id,
					__v: Number(candidate.reservation.__v || 0),
					...identityFilter,
				},
				update: {
					$set: { otaIdentityKey: candidate.otaIdentityKey },
					$inc: { __v: 1 },
					$push: {
						reservationAuditLog: {
							at: new Date(),
							source: "ota-identity-backfill",
							action: "canonical-ota-identity-added",
							by: SYSTEM_ACTOR,
							from: { otaIdentityKey: candidate.previousIdentityKey },
							to: { otaIdentityKey: candidate.otaIdentityKey },
							evidenceAuditIds: candidate.auditIds,
						},
					},
				},
			},
		};
	});
	// Production MongoDB is standalone, so multi-document transactions are not
	// available. One ordered bulk command plus exact old-value/version filters and
	// the unique index keeps every individual identity update guarded and idempotent.
	const bulkResult = await Reservations.bulkWrite(operations, { ordered: true });
	const matchedCount = Number(
		bulkResult.matchedCount ?? bulkResult.nMatched ?? bulkResult.result?.nMatched ?? 0
	);
	const modifiedCount = Number(
		bulkResult.modifiedCount ??
			bulkResult.nModified ??
			bulkResult.result?.nModified ??
			0
	);
	assert.equal(matchedCount, candidates.length, "not every guarded identity matched");
	assert.equal(modifiedCount, candidates.length, "not every identity was updated");

	const afterReservations = await Reservations.find({
		_id: { $in: candidates.map((candidate) => candidate.reservation._id) },
	})
		.select(
			"_id __v otaIdentityKey reservation_id confirmation_number booking_source customer_details supplierData otaPlatformReview reservation_status state currency total_amount sub_total"
		)
		.lean();
	const afterById = new Map(
		afterReservations.map((reservation) => [id(reservation._id), reservation])
	);
	for (const candidate of candidates) {
		assert.equal(
			afterById.get(candidate.reservationId)?.otaIdentityKey,
			candidate.otaIdentityKey,
			`post-write identity mismatch: ${candidate.reservationId}`
		);
	}
	const duplicateGroups = await Reservations.aggregate([
		{ $match: { otaIdentityKey: { $in: candidates.map((candidate) => candidate.otaIdentityKey) } } },
		{ $group: { _id: "$otaIdentityKey", count: { $sum: 1 } } },
		{ $match: { count: { $gt: 1 } } },
	]);
	assert.deepEqual(duplicateGroups, [], "duplicate OTA identities exist after backfill");

	const afterSnapshot = writeSnapshot("after", {
		createdAt: new Date(),
		beforeSnapshot,
		reservations: afterReservations,
	});
	console.log(`After snapshot: ${afterSnapshot}`);
	console.log(JSON.stringify({ success: true, updatedCount: candidates.length }, null, 2));
}

main()
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(async () => {
		if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
	});
