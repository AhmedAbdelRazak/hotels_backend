/** @format */

"use strict";

require("dotenv").config();

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const mongoose = require("mongoose");

const InboundEmail = require("../models/inbound_email");
const HotelDetails = require("../models/hotel_details");
const Reservations = require("../models/reservations");
const {
	buildOtaIdentityKey,
	buildReservationDocument,
	extractNormalizedReservation,
	findReservationByOtaConfirmation,
	reconcileOtaReservation,
	resolveHotel,
	resolveRoomMatch,
} = require("../services/otaReservationMapper");
const {
	OTA_PLATFORM_REVIEW_PENDING,
	OTA_PLATFORM_REVIEW_RELEASED,
	OTA_RELEASED_RESERVATION_STATUS,
} = require("../services/otaReservationVisibility");
const {
	validateOtaReleaseHotelBasePrice,
} = require("../services/otaReviewPricingInvariants");

const APPLY = process.argv.includes("--apply");
const RELEASE = process.argv.includes("--release");
const AJYAD_HOTEL_ID = "6a40b6a1a6efe70450536038";
const INCIDENT_START = new Date("2026-07-24T00:00:00.000Z");
const INCIDENT_END = new Date("2026-07-26T00:00:00.000Z");

if (RELEASE && !APPLY) {
	throw new Error("--release is only valid together with --apply.");
}

const REPAIRS = [
	{
		provider: "airbnb",
		confirmationNumber: "hmhbhjdjjm",
		primaryAuditId: "6a648f3e6c3709a57e712b9f",
		guestName: /Mubashar Kalyar/i,
		checkinDate: "2026-07-25",
		checkoutDate: "2026-07-26",
		totalAmountSar: 102.46,
		totalPayoutSar: 73.36,
		roomCount: 1,
		totalGuests: 6,
		roomName: /6|six/i,
		expectedRoomId: "6a4a84216022cd7f31729011",
		minimumRelatedAudits: 2,
	},
	{
		provider: "agoda",
		confirmationNumber: "2035713707",
		primaryAuditId: "6a64a65a6c3709a57e71505e",
		guestName: /Novrizal Aulia Rachman/i,
		checkinDate: "2026-07-25",
		checkoutDate: "2026-07-26",
		totalAmountSar: 70,
		totalPayoutSar: 41.16,
		roomCount: 1,
		totalGuests: 4,
		roomName: /Deluxe Family Room 2/i,
		expectedRoomId: "6a40e45a1a6d1850eb25c58b",
		minimumRelatedAudits: 2,
		corroboratingRoomName: /4\s*Occupancy|four/i,
		overrideRoomName: "Deluxe Family Room - 4 Occupancy",
	},
	{
		provider: "agoda",
		confirmationNumber: "2035742642",
		primaryAuditId: "6a64a66f6c3709a57e71507c",
		guestName: /yusaif hmood Almamri/i,
		checkinDate: "2026-07-28",
		checkoutDate: "2026-07-31",
		totalAmountSar: 490.02,
		totalPayoutSar: 288.12,
		roomCount: 2,
		totalGuests: 5,
		roomName: /5 Beds Room/i,
		expectedRoomId: "6a40e4ec1a6d1850eb25c635",
		minimumRelatedAudits: 2,
		allowHomogeneousMultiRoom: true,
	},
];

const SYSTEM_ACTOR = {
	name: "OTA incident repair 2026-07-25",
	email: "system@jannatbooking.com",
	role: "system",
};

const round2 = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const id = (value) => String(value?._id || value || "");
const ymd = (value) => {
	if (!value) return "";
	if (value instanceof Date && !Number.isNaN(value.getTime())) {
		return value.toISOString().slice(0, 10);
	}
	return String(value).slice(0, 10);
};

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

function normalizeAudit(audit) {
	const normalized = extractNormalizedReservation(emailFromAudit(audit));
	normalized.inboundEmailId = id(audit._id);
	return normalized;
}

function isAuditForRepair(audit, normalized, repair) {
	const storedConfirmation = String(audit.confirmationNumber || "").toLowerCase();
	return (
		String(normalized.provider || audit.provider || "").toLowerCase() === repair.provider &&
		(String(normalized.confirmationNumber || "").toLowerCase() ===
			repair.confirmationNumber ||
			storedConfirmation === repair.confirmationNumber)
	);
}

function assertMoney(actual, expected, label) {
	assert.equal(round2(actual), round2(expected), label);
}

function assertSourceBacked(normalized, repair) {
	assert.equal(normalized.provider, repair.provider, "provider mismatch");
	assert.equal(
		normalized.confirmationNumber,
		repair.confirmationNumber,
		"confirmation mismatch"
	);
	assert.match(normalized.guestName || "", repair.guestName, "guest mismatch");
	assert.equal(normalized.checkinDate, repair.checkinDate, "check-in mismatch");
	assert.equal(normalized.checkoutDate, repair.checkoutDate, "check-out mismatch");
	assert.equal(Number(normalized.roomCount), repair.roomCount, "room-count mismatch");
	assert.equal(Number(normalized.totalGuests), repair.totalGuests, "guest-count mismatch");
	assert.match(normalized.roomName || "", repair.roomName, "room-name mismatch");
	assertMoney(normalized.totalAmountSar, repair.totalAmountSar, "guest-total mismatch");
	assertMoney(
		normalized.totalPayoutSar || normalized.netAfterExpensesTotal,
		repair.totalPayoutSar,
		"OTA-payout mismatch"
	);
	for (const field of [
		"confirmationNumber",
		"guestName",
		"hotelName",
		"roomName",
		"checkinDate",
		"checkoutDate",
		"amount",
	]) {
		assert.equal(normalized.sourcePresence?.[field], true, `${field} is not source-backed`);
	}
}

function applyVerifiedOverrides(normalized, repair) {
	const next = {
		...normalized,
		hotelId: AJYAD_HOTEL_ID,
		hotelIdMatchStrength: "incident_verified_property",
		warnings: [...(normalized.warnings || [])],
	};
	if (repair.overrideRoomName) {
		next.roomName = repair.overrideRoomName;
		next.sourcePresence = { ...next.sourcePresence, roomName: true };
		next.warnings.push(
			"Room capacity was corroborated by the matching HotelRunner copy during the 2026-07-25 incident repair."
		);
	}
	if (repair.allowHomogeneousMultiRoom) {
		next.requiresManualReview = false;
		next.manualReviewReasons = [];
		next.warnings.push(
			"Two homogeneous five-bed room blocks, matching stay dates, aggregate occupancy, and payout were verified during the 2026-07-25 incident repair."
		);
	}
	return next;
}

function reservationSummary(reservation) {
	if (!reservation) return null;
	return {
		_id: id(reservation._id),
		otaIdentityKey: reservation.otaIdentityKey,
		pmsConfirmationNumber: reservation.confirmation_number,
		hotelId: id(reservation.hotelId),
		guestName: reservation.customer_details?.name || "",
		checkinDate: reservation.checkin_date,
		checkoutDate: reservation.checkout_date,
		totalRooms: reservation.total_rooms,
		totalGuests: reservation.total_guests,
		totalAmount: reservation.total_amount,
		hotelAmount: reservation.sub_total,
		roomIds: (reservation.pickedRoomsType || []).map((room) =>
			id(room.hotelRoomConfigId)
		),
		state: reservation.state,
		reservationStatus: reservation.reservation_status,
		otaPlatformReviewStatus: reservation.otaPlatformReview?.status || "",
		pendingConfirmationStatus: reservation.pendingConfirmation?.status || "",
	};
}

function assertReservationIntegrity(reservation, repair) {
	assert.ok(reservation, "reservation was not found after reconciliation");
	assert.equal(
		reservation.otaIdentityKey,
		buildOtaIdentityKey(repair.provider, repair.confirmationNumber),
		"OTA identity mismatch"
	);
	assert.equal(id(reservation.hotelId), AJYAD_HOTEL_ID, "hotel mismatch");
	assert.match(reservation.customer_details?.name || "", repair.guestName, "guest mismatch");
	assert.equal(ymd(reservation.checkin_date), repair.checkinDate, "check-in mismatch");
	assert.equal(ymd(reservation.checkout_date), repair.checkoutDate, "check-out mismatch");
	assert.equal(Number(reservation.total_rooms), repair.roomCount, "room-count mismatch");
	assert.equal(Number(reservation.total_guests), repair.totalGuests, "guest-count mismatch");
	assertMoney(reservation.total_amount, repair.totalAmountSar, "guest-total mismatch");
	assert.equal(
		(reservation.pickedRoomsType || []).length,
		repair.roomCount,
		"saved room rows mismatch"
	);
	for (const room of reservation.pickedRoomsType || []) {
		assert.equal(id(room.hotelRoomConfigId), repair.expectedRoomId, "PMS room mismatch");
	}
}

function jsonSafe(value) {
	return JSON.parse(JSON.stringify(value));
}

function createSnapshotPath(stage) {
	const directory = path.resolve(
		process.env.OTA_INCIDENT_BACKUP_DIR ||
			path.join(process.cwd(), "..", "deploy-backups")
	);
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	return path.join(directory, `ota-20260725-${stamp}-${stage}.json`);
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

async function buildDryRunDocument(normalized) {
	const hotel = await resolveHotel(normalized);
	assert.ok(hotel, "verified Ajyad hotel did not resolve");
	assert.equal(id(hotel._id), AJYAD_HOTEL_ID, "resolved an unexpected hotel");
	const roomMatch = resolveRoomMatch(hotel, normalized.roomName, {
		totalGuests: normalized.totalGuests,
		normalized,
	});
	assert.ok(roomMatch.roomDetails, `room did not resolve: ${normalized.roomName}`);
	const built = buildReservationDocument(normalized, hotel, { roomMatch });
	assert.equal(built.ok, true, built.error || "reservation build failed");
	const dryRunReviewedAt = new Date();
	const reviewedDocument = {
		...built.document,
		adminPricing: {
			...(built.document.adminPricing || {}),
			mode: "ota_review",
			pricingReviewRequired: false,
			roomMappingHotelId: AJYAD_HOTEL_ID,
			sourceClientTotalSar: round2(built.document.total_amount),
			sourceClientTotalSource: "supplierData.otaAmountSar",
			sourceClientTotalLockedAt: dryRunReviewedAt,
			clientTotalOverrideActive: false,
			clientTotalOverrideSar: 0,
		},
		otaPlatformReview: {
			...(built.document.otaPlatformReview || {}),
			status: OTA_PLATFORM_REVIEW_PENDING,
			lastPricingUpdatedAt: dryRunReviewedAt,
			roomMappingStatus: "reviewed",
			roomMappingHotelId: AJYAD_HOTEL_ID,
		},
	};
	const releaseValidation = validateOtaReleaseHotelBasePrice(reviewedDocument, {
		hotel,
	});
	assert.equal(
		releaseValidation.ready,
		true,
		releaseValidation.message || "release pricing validation failed"
	);
	return { hotel, roomMatch, built, releaseValidation };
}

async function reviewPricingAndRelease(reservation, hotel) {
	if (
		String(reservation.otaPlatformReview?.status || "").toLowerCase() ===
		OTA_PLATFORM_REVIEW_RELEASED
	) {
		return reservation;
	}
	assert.equal(
		String(reservation.otaPlatformReview?.status || "").toLowerCase(),
		OTA_PLATFORM_REVIEW_PENDING,
		"reservation is not in pending OTA platform review"
	);

	const pricingReviewedAt = new Date();
	const sourceClientTotal = round2(reservation.total_amount);
	const reviewedAdminPricing = {
		...(reservation.adminPricing || {}),
		mode: "ota_review",
		commissionAmount: 0,
		pricingReviewRequired: false,
		roomMappingHotelId: AJYAD_HOTEL_ID,
		sourceClientTotalSar: sourceClientTotal,
		sourceClientTotalSource: "supplierData.otaAmountSar",
		sourceClientTotalLockedAt: pricingReviewedAt,
		clientTotalOverrideActive: false,
		clientTotalOverrideSar: 0,
	};
	const reviewedOtaPlatformReview = {
		...(reservation.otaPlatformReview || {}),
		status: OTA_PLATFORM_REVIEW_PENDING,
		lastPricingUpdatedAt: pricingReviewedAt,
		lastPricingUpdatedBy: SYSTEM_ACTOR,
		roomMappingStatus: "reviewed",
		roomMappingHotelId: AJYAD_HOTEL_ID,
	};
	const pricingValidation = validateOtaReleaseHotelBasePrice(
		{
			...reservation,
			adminPricing: reviewedAdminPricing,
			otaPlatformReview: reviewedOtaPlatformReview,
		},
		{ hotel }
	);
	assert.equal(
		pricingValidation.ready,
		true,
		pricingValidation.message || "release pricing validation failed"
	);
	const pricingUpdate = {
		commission: 0,
		pickedRoomsType: pricingValidation.canonicalRooms,
		pickedRoomsPricing: pricingValidation.canonicalRooms,
		adminPricing: reviewedAdminPricing,
		financial_cycle: {
			...(reservation.financial_cycle || {}),
			commissionType: "amount",
			commissionValue: 0,
			commissionAmount: 0,
			commissionAssigned: false,
			commissionDueToPms: 0,
			lastUpdatedAt: pricingReviewedAt,
			lastUpdatedBy: null,
		},
		otaPlatformReview: reviewedOtaPlatformReview,
		adminLastUpdatedAt: pricingReviewedAt,
		adminLastUpdatedBy: SYSTEM_ACTOR,
	};
	const reviewed = await Reservations.findOneAndUpdate(
		{
			_id: reservation._id,
			__v: Number(reservation.__v || 0),
			"otaPlatformReview.status": OTA_PLATFORM_REVIEW_PENDING,
		},
		{
			$set: pricingUpdate,
			$inc: { __v: 1 },
			$push: {
				reservationAuditLog: {
					at: pricingReviewedAt,
					source: "ota-incident-repair",
					action: "pricing-reviewed-before-release",
					by: SYSTEM_ACTOR,
					from: { commission: reservation.commission },
					to: {
						commission: 0,
						hotel_visible_amount: pricingValidation.hotelBaseTotal,
						source_client_total_sar: sourceClientTotal,
					},
				},
			},
		},
		{ new: true }
	).lean();
	assert.ok(reviewed, "concurrent change blocked pricing review");

	const releaseValidation = validateOtaReleaseHotelBasePrice(reviewed, { hotel });
	assert.equal(
		releaseValidation.ready,
		true,
		releaseValidation.message || "post-review release validation failed"
	);
	const releasedAt = new Date();
	const released = await Reservations.findOneAndUpdate(
		{
			_id: reviewed._id,
			__v: Number(reviewed.__v || 0),
			"otaPlatformReview.status": OTA_PLATFORM_REVIEW_PENDING,
		},
		{
			$set: {
				state: OTA_RELEASED_RESERVATION_STATUS,
				reservation_status: OTA_RELEASED_RESERVATION_STATUS,
				pickedRoomsType: releaseValidation.canonicalRooms,
				pickedRoomsPricing: releaseValidation.canonicalRooms,
				pendingConfirmation: {
					...(reviewed.pendingConfirmation || {}),
					status: "pending",
					source: "ota_platform_release",
					rejectionReason: "",
					confirmationReason: "",
					confirmedAt: null,
					rejectedAt: null,
					releasedToHotelAt: releasedAt,
					lastUpdatedAt: releasedAt,
					lastUpdatedBy: SYSTEM_ACTOR,
				},
				otaPlatformReview: {
					...(reviewed.otaPlatformReview || {}),
					status: OTA_PLATFORM_REVIEW_RELEASED,
					releasedAt,
					releasedBy: SYSTEM_ACTOR,
					priceAtRelease: releaseValidation.hotelBaseTotal,
					zeroHotelBasePriceRelease: null,
				},
				adminPricingVisibility: {
					...(reviewed.adminPricingVisibility || {}),
					rootOnlyForHotelManagement: true,
					source: "ota_platform_release",
					appliedAt: releasedAt,
					appliedBy: null,
				},
				adminLastUpdatedAt: releasedAt,
				adminLastUpdatedBy: SYSTEM_ACTOR,
			},
			$inc: { __v: 1 },
			$push: {
				reservationAuditLog: {
					at: releasedAt,
					source: "ota-incident-repair",
					action: "released-to-hotel",
					by: SYSTEM_ACTOR,
					to: {
						reservation_status: OTA_RELEASED_RESERVATION_STATUS,
						hotel_visible_amount: releaseValidation.hotelBaseTotal,
						zero_hotel_base_price_override: false,
					},
				},
			},
		},
		{ new: true }
	).lean();
	assert.ok(released, "concurrent change blocked release");
	return released;
}

async function linkAudits(repair, normalized, reservation, relatedAudits) {
	for (const entry of relatedAudits) {
		const isPrimary = id(entry.audit._id) === repair.primaryAuditId;
		const status = isPrimary ? "created" : "duplicate_reservation";
		const set = {
			provider: repair.provider,
			providerLabel: normalized.providerLabel,
			intent: normalized.intent,
			eventType: normalized.eventType,
			processingStatus: status,
			confirmationNumber: repair.confirmationNumber,
			pmsConfirmationNumber: reservation.confirmation_number,
			hotelName: normalized.hotelName,
			hotelId: reservation.hotelId,
			reservationMongoId: reservation._id,
			hasReservationConnection: true,
			matchedReservationBy: ["otaIdentityKey", "incident_repair_20260725"],
			automationAction: isPrimary ? "backfilled" : "linked_duplicate",
			skipReason: isPrimary ? "" : "duplicate_existing_reservation_no_update",
			automationComment: isPrimary
				? "Missing source-backed OTA reservation was backfilled after parser and mapping repair."
				: "Matching OTA delivery was linked to the repaired reservation; no duplicate was created.",
			reconciliation: {
				status,
				actionTaken: isPrimary ? "incident_backfill" : "linked_duplicate",
				reservationId: reservation._id,
				hotelId: reservation.hotelId,
				pmsConfirmationNumber: reservation.confirmation_number,
				matchedReservationBy: ["otaIdentityKey", "incident_repair_20260725"],
				repairedAt: new Date(),
			},
			processedAt: new Date(),
		};
		if (isPrimary) set.normalizedReservation = normalized;
		// Each audit is updated by exact immutable _id only.
		// eslint-disable-next-line no-await-in-loop
		await InboundEmail.updateOne({ _id: entry.audit._id }, { $set: set });
	}
}

async function main() {
	const database =
		process.env.DATABASE || process.env.MONGO_URI || process.env.MONGODB_URI;
	if (!database) throw new Error("Missing DATABASE/MONGO connection string.");
	await mongoose.connect(database, { autoIndex: false });

	const primaryIds = REPAIRS.map((repair) => repair.primaryAuditId);
	const targetConfirmations = REPAIRS.map(
		(repair) => repair.confirmationNumber
	);
	const targetConfirmationPattern = new RegExp(
		targetConfirmations.join("|"),
		"i"
	);
	const candidateAudits = await InboundEmail.find({
		$or: [
			{ _id: { $in: primaryIds } },
			{
				$and: [
					{ receivedAt: { $gte: INCIDENT_START, $lt: INCIDENT_END } },
					{
						$or: [
							{ confirmationNumber: { $in: targetConfirmations } },
							{ bodyText: targetConfirmationPattern },
						],
					},
				],
			},
		],
	})
		.sort({ receivedAt: 1, _id: 1 })
		.lean();
	const candidateEntries = candidateAudits.map((audit) => ({
		audit,
		normalized: normalizeAudit(audit),
	}));

	const plans = [];
	for (const repair of REPAIRS) {
		const primary = candidateEntries.find(
			(entry) => id(entry.audit._id) === repair.primaryAuditId
		);
		assert.ok(primary, `primary audit not found: ${repair.primaryAuditId}`);
		assertSourceBacked(primary.normalized, repair);
		const relatedAudits = candidateEntries.filter((entry) =>
			isAuditForRepair(entry.audit, entry.normalized, repair)
		);
		assert.ok(
			relatedAudits.length >= repair.minimumRelatedAudits,
			`expected at least ${repair.minimumRelatedAudits} matching audits for ${repair.confirmationNumber}`
		);
		if (repair.corroboratingRoomName) {
			assert.ok(
				relatedAudits.some(
					(entry) =>
						id(entry.audit._id) !== repair.primaryAuditId &&
						repair.corroboratingRoomName.test(entry.normalized.roomName || "")
				),
				`HotelRunner room-capacity corroboration is missing for ${repair.confirmationNumber}`
			);
		}

		const normalized = applyVerifiedOverrides(primary.normalized, repair);
		const existing = await findReservationByOtaConfirmation(
			repair.confirmationNumber,
			repair.provider
		);
		let dryRun = null;
		if (existing) {
			assertReservationIntegrity(existing, repair);
		} else {
			dryRun = await buildDryRunDocument(normalized);
			assert.equal(
				id(dryRun.roomMatch.roomDetails?._id),
				repair.expectedRoomId,
				"dry-run PMS room mismatch"
			);
		}
		plans.push({ repair, primary, relatedAudits, normalized, existing, dryRun });
	}

	console.log(
		JSON.stringify(
			{
				mode: APPLY ? (RELEASE ? "apply-and-release" : "apply") : "dry-run",
				repairs: plans.map(({ repair, relatedAudits, normalized, existing, dryRun }) => ({
					provider: repair.provider,
					confirmationNumber: repair.confirmationNumber,
					auditIds: relatedAudits.map((entry) => id(entry.audit._id)),
					guestName: normalized.guestName,
					stay: [normalized.checkinDate, normalized.checkoutDate],
					roomName: normalized.roomName,
					roomCount: normalized.roomCount,
					totalGuests: normalized.totalGuests,
					guestTotalSar: normalized.totalAmountSar,
					payoutSar: normalized.totalPayoutSar || normalized.netAfterExpensesTotal,
					pmsRoomId:
						id(existing?.pickedRoomsType?.[0]?.hotelRoomConfigId) ||
						id(dryRun?.roomMatch?.roomDetails?._id),
					hotelVisibleAmount:
						existing?.sub_total || dryRun?.releaseValidation?.hotelBaseTotal || 0,
					existing: reservationSummary(existing),
				})),
			},
			null,
			2
		)
	);

	if (!APPLY) return;
	const targetAuditIds = plans.flatMap((plan) =>
		plan.relatedAudits.map((entry) => entry.audit._id)
	);
	const existingReservations = await Reservations.find({
		otaIdentityKey: {
			$in: REPAIRS.map((repair) =>
				buildOtaIdentityKey(repair.provider, repair.confirmationNumber)
			),
		},
	}).lean();
	const beforeSnapshot = writeSnapshot("before", {
		createdAt: new Date(),
		mode: RELEASE ? "apply-and-release" : "apply",
		audits: await InboundEmail.find({ _id: { $in: targetAuditIds } }).lean(),
		reservations: existingReservations,
	});
	console.log(`Before snapshot: ${beforeSnapshot}`);

	const results = [];
	for (const plan of plans) {
		const { repair, normalized, relatedAudits } = plan;
		// The reconciler is identity-key idempotent and rechecks before create.
		// eslint-disable-next-line no-await-in-loop
		const reconciliation = await reconcileOtaReservation(normalized);
		assert.ok(
			["created", "duplicate_reservation"].includes(reconciliation.status),
			`unexpected reconciliation status for ${repair.confirmationNumber}: ${reconciliation.status}`
		);
		// eslint-disable-next-line no-await-in-loop
		let reservation = await findReservationByOtaConfirmation(
			repair.confirmationNumber,
			repair.provider
		);
		assertReservationIntegrity(reservation, repair);
		if (RELEASE) {
			// eslint-disable-next-line no-await-in-loop
			const hotel = await HotelDetails.findById(AJYAD_HOTEL_ID)
				.select("_id hotelName roomCountDetails")
				.lean();
			assert.ok(hotel, "Ajyad hotel disappeared during release");
			// eslint-disable-next-line no-await-in-loop
			reservation = await reviewPricingAndRelease(reservation.toObject?.() || reservation, hotel);
		}
		assertReservationIntegrity(reservation, repair);
		// eslint-disable-next-line no-await-in-loop
		await linkAudits(repair, normalized, reservation, relatedAudits);
		results.push({ reconciliation, reservation: reservationSummary(reservation) });
	}

	const afterReservations = await Reservations.find({
		otaIdentityKey: {
			$in: REPAIRS.map((repair) =>
				buildOtaIdentityKey(repair.provider, repair.confirmationNumber)
			),
		},
	}).lean();
	const afterSnapshot = writeSnapshot("after", {
		createdAt: new Date(),
		beforeSnapshot,
		audits: await InboundEmail.find({ _id: { $in: targetAuditIds } }).lean(),
		reservations: afterReservations,
	});
	console.log(`After snapshot: ${afterSnapshot}`);
	console.log(JSON.stringify({ success: true, results }, null, 2));
}

main()
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(async () => {
		if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
	});
