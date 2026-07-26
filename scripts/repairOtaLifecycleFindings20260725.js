/** @format */

"use strict";

require("dotenv").config();

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const mongoose = require("mongoose");

const HotelDetails = require("../models/hotel_details");
const InboundEmail = require("../models/inbound_email");
const Reservations = require("../models/reservations");
const {
	buildOtaConfirmationLookup,
	extractNormalizedReservation,
	reconcileOtaReservation,
	resolveHotel,
} = require("../services/otaReservationMapper");
const {
	invalidateOtaRoomPricingForHotelAssignment,
	resolveOtaSourceClientTotal,
} = require("../services/otaReviewPricingInvariants");
const {
	addReservationVersionBump,
	buildReservationSnapshotFilter,
} = require("../services/otaReviewConcurrency");

const APPLY = process.argv.includes("--apply");
const AJYAD_HOTEL_ID = "6a40b6a1a6efe70450536038";
const HOTEL_ASSIGNMENT = {
	auditId: "6a65284019d095ec1ac4371f",
	reservationId: "6a65284a19d095ec1ac4373b",
	provider: "agoda",
	confirmationNumber: "682746775",
};
const CANCELLATIONS = [
	{
		auditId: "6a653fa919d095ec1ac448e6",
		provider: "expedia",
		confirmationNumber: "2518668243",
	},
	{
		auditId: "6a65297919d095ec1ac43884",
		provider: "expedia",
		confirmationNumber: "2514976765",
	},
	{
		auditId: "6a64cfa2c8620b708c398d45",
		provider: "airbnb",
		confirmationNumber: "hmj3pkxw54",
	},
];
const SYSTEM_ACTOR = {
	name: "OTA lifecycle repair 2026-07-25",
	role: "system",
};

const id = (value) => String(value?._id || value || "");
const emailFromAudit = (audit) => ({
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
});
const stableHash = (value) =>
	crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const protectedReservationFacts = (reservation = {}) => ({
	pickedRoomsType: reservation.pickedRoomsType,
	pickedRoomsPricing: reservation.pickedRoomsPricing,
	total_rooms: reservation.total_rooms,
	total_amount: reservation.total_amount,
	sub_total: reservation.sub_total,
	commission: reservation.commission,
	paid_amount: reservation.paid_amount,
	paid_amount_breakdown: reservation.paid_amount_breakdown,
	payment: reservation.payment,
	adminPricing: reservation.adminPricing,
	financial_cycle: reservation.financial_cycle,
});
const snapshotPath = (stage) =>
	path.join(
		os.tmpdir(),
		`jannat-ota-lifecycle-20260725-${new Date()
			.toISOString()
			.replace(/[:.]/g, "-")}-${stage}.json`
	);
const writeSnapshot = (stage, payload) => {
	const target = snapshotPath(stage);
	fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, {
		encoding: "utf8",
		flag: "wx",
	});
	return target;
};

async function loadExactCancellationPlan(target) {
	const audit = await InboundEmail.findById(target.auditId).lean();
	assert.ok(audit, `Missing cancellation audit ${target.auditId}`);
	const normalized = extractNormalizedReservation(emailFromAudit(audit));
	normalized.inboundEmailId = id(audit._id);
	assert.equal(normalized.provider, target.provider, "provider mismatch");
	assert.equal(
		normalized.confirmationNumber,
		target.confirmationNumber,
		"OTA confirmation mismatch"
	);
	assert.equal(normalized.intent, "reservation_status", "status intent missing");
	assert.equal(normalized.eventType, "cancelled", "cancellation event missing");
	assert.equal(normalized.statusToApply, "cancelled", "cancel status missing");
	assert.equal(
		new Date(normalized.source.receivedAt).getTime(),
		new Date(audit.receivedAt).getTime(),
		"source receipt time mismatch"
	);
	const lookup = buildOtaConfirmationLookup(
		target.confirmationNumber,
		target.provider
	);
	const matches = await Reservations.find(lookup).lean();
	assert.equal(matches.length, 1, "cancellation must match exactly one reservation");
	return { target, audit, normalized, reservation: matches[0] };
}

async function loadHotelAssignmentPlan() {
	const audit = await InboundEmail.findById(HOTEL_ASSIGNMENT.auditId).lean();
	assert.ok(audit, "Hotel-assignment source audit is missing");
	const normalized = extractNormalizedReservation(emailFromAudit(audit));
	normalized.inboundEmailId = id(audit._id);
	assert.equal(normalized.provider, HOTEL_ASSIGNMENT.provider);
	assert.equal(
		normalized.confirmationNumber,
		HOTEL_ASSIGNMENT.confirmationNumber
	);
	const resolvedHotel = await resolveHotel(normalized);
	assert.ok(resolvedHotel, "Current parser did not resolve the OTA hotel");
	assert.equal(id(resolvedHotel._id), AJYAD_HOTEL_ID, "unexpected hotel resolution");
	assert.equal(resolvedHotel.activateHotel, true, "resolved hotel is inactive");
	assert.notEqual(resolvedHotel.xHotelProActive, false, "resolved hotel is disabled");
	const hotel = await HotelDetails.findById(AJYAD_HOTEL_ID)
		.select("_id hotelName hotelName_OtherLanguage belongsTo")
		.lean();
	assert.ok(hotel?.belongsTo, "resolved hotel has no owner assignment");
	const reservation = await Reservations.findById(
		HOTEL_ASSIGNMENT.reservationId
	).lean();
	assert.ok(reservation, "Hotel-assignment reservation is missing");
	assert.equal(
		String(reservation.reservation_id || "").toLowerCase(),
		HOTEL_ASSIGNMENT.confirmationNumber
	);
	assert.equal(
		String(reservation.otaPlatformReview?.status || "").toLowerCase(),
		"pending"
	);
	assert.ok(
		!reservation.hotelId || id(reservation.hotelId) === AJYAD_HOTEL_ID,
		"reservation is assigned to a different hotel"
	);
	return { audit, normalized, hotel, reservation };
}

async function applyHotelAssignment(plan) {
	if (id(plan.reservation.hotelId) === AJYAD_HOTEL_ID) return plan.reservation;
	const { hotel, reservation } = plan;
	const now = new Date();
	const sourceClientTotal = resolveOtaSourceClientTotal(reservation);
	const set = {
		hotelId: mongoose.Types.ObjectId(hotel._id),
		belongsTo: mongoose.Types.ObjectId(hotel.belongsTo),
		roomId: [],
		pickedRoomsType: invalidateOtaRoomPricingForHotelAssignment(
			reservation.pickedRoomsType
		),
		pickedRoomsPricing: invalidateOtaRoomPricingForHotelAssignment(
			Array.isArray(reservation.pickedRoomsPricing) &&
				reservation.pickedRoomsPricing.length
				? reservation.pickedRoomsPricing
				: reservation.pickedRoomsType
		),
		sub_total: 0,
		commission: 0,
		otaPlatformReview: {
			...(reservation.otaPlatformReview || {}),
			status: "pending",
			hotelAssignmentRequired: false,
			hotelAssignmentStatus: "assigned",
			assignedHotelId: id(hotel._id),
			assignedHotelName: hotel.hotelName || "",
			assignedAt: now,
			assignedBy: SYSTEM_ACTOR,
			lastPricingUpdatedAt: null,
			lastPricingUpdatedBy: null,
			pricingReviewInvalidatedAt: now,
			pricingReviewInvalidatedBy: SYSTEM_ACTOR,
			pricingReviewInvalidatedReason: "verified_parser_hotel_assignment",
			roomMappingStatus: "unreviewed",
			roomMappingHotelId: "",
			lastUpdatedAt: now,
		},
		adminPricing: {
			...(reservation.adminPricing || {}),
			mode: "ota_assignment_pending_pricing",
			clientTotal:
				sourceClientTotal.amount || Number(reservation.total_amount || 0),
			rootTotal: 0,
			platformMarginTotal: 0,
			commissionAmount: 0,
			sourceClientTotalSar:
				sourceClientTotal.amount || Number(reservation.total_amount || 0),
			sourceClientTotalSource:
				sourceClientTotal.source || "reservation.total_amount",
			pricingReviewRequired: true,
			pricingReviewInvalidatedAt: now,
			hotelAssignmentRequired: false,
			assignedHotelId: id(hotel._id),
			assignedHotelName: hotel.hotelName || "",
		},
		adminLastUpdatedAt: now,
		adminLastUpdatedBy: SYSTEM_ACTOR,
		"supplierData.otaHotelMappingRequired": false,
		"supplierData.otaAssignedHotelId": id(hotel._id),
		"supplierData.otaAssignedHotelName": hotel.hotelName || "",
		"supplierData.otaAssignedHotelAt": now,
		"supplierData.otaAssignedHotelBy": SYSTEM_ACTOR,
		"supplierData.otaMatchedRoomName": "",
		"supplierData.otaRoomMatchScore": 0,
		"supplierData.otaRoomMatchType": "",
	};
	const updated = await Reservations.findOneAndUpdate(
		buildReservationSnapshotFilter(reservation, {
			requirePendingReview: true,
			includeHotel: true,
		}),
		addReservationVersionBump({
			$set: set,
			$push: {
				reservationAuditLog: {
					at: now,
					source: "ota-lifecycle-repair",
					action: "hotel-auto-assigned-after-parser-verification",
					by: SYSTEM_ACTOR,
					from: {
						hotelId: "",
						hotelName: reservation.supplierData?.otaHotelName || "",
					},
					to: {
						hotelId: id(hotel._id),
						hotelName: hotel.hotelName || "",
						pricingReviewRequired: true,
					},
				},
			},
		}),
		{ new: true }
	).lean();
	assert.ok(updated, "concurrent change blocked hotel assignment");
	assert.equal(id(updated.hotelId), AJYAD_HOTEL_ID);
	assert.equal(Number(updated.total_amount), Number(reservation.total_amount));
	assert.equal(
		Number(updated.adminPricing?.clientTotal),
		Number(reservation.adminPricing?.clientTotal)
	);
	return updated;
}

async function applyCancellation(plan) {
	const beforeHash = stableHash(protectedReservationFacts(plan.reservation));
	let reconciliation = null;
	if (
		String(plan.reservation.reservation_status || "").toLowerCase() !==
		"cancelled"
	) {
		reconciliation = await reconcileOtaReservation(plan.normalized);
		assert.equal(reconciliation.status, "cancelled");
	}
	const updated = await Reservations.findById(plan.reservation._id).lean();
	assert.ok(updated, "reservation disappeared during cancellation repair");
	assert.equal(String(updated.reservation_status).toLowerCase(), "cancelled");
	assert.equal(String(updated.state).toLowerCase(), "cancelled");
	assert.equal(
		String(updated.pendingConfirmation?.status || "").toLowerCase(),
		"cancelled"
	);
	assert.equal(
		String(updated.agentDecisionSnapshot?.status || "").toLowerCase(),
		"cancelled"
	);
	assert.equal(
		String(updated.otaPlatformReview?.status || "").toLowerCase(),
		"closed"
	);
	assert.equal(
		stableHash(protectedReservationFacts(updated)),
		beforeHash,
		"status-only repair changed protected room/pricing/finance data"
	);
	const auditUpdate = {
		provider: plan.normalized.provider,
		providerLabel: plan.normalized.providerLabel,
		intent: "reservation_status",
		eventType: "cancelled",
		processingStatus: "cancelled",
		confirmationNumber: plan.target.confirmationNumber,
		pmsConfirmationNumber: updated.confirmation_number,
		hotelId: updated.hotelId || null,
		reservationMongoId: updated._id,
		hasReservationConnection: true,
		matchedReservationBy:
			reconciliation?.matchedReservationBy || plan.audit.matchedReservationBy || [],
		automationAction: "status_updated",
		skipReason: "",
		automationComment:
			"Verified OTA cancellation applied to the exact existing reservation; no room, pricing, payment, or finance fields were changed.",
		normalizedReservation: plan.normalized,
		reconciliation:
			reconciliation || {
				status: "cancelled",
				actionTaken: "already_current",
				reservationId: updated._id,
			},
		reconcileWarnings: reconciliation?.warnings || [],
		reconcileErrors: reconciliation?.errors || [],
		processedAt: new Date(),
	};
	await InboundEmail.updateOne({ _id: plan.audit._id }, { $set: auditUpdate });
	return { updated, reconciliation };
}

async function main() {
	const database =
		process.env.DATABASE || process.env.MONGO_URI || process.env.MONGODB_URI;
	if (!database) throw new Error("Missing DATABASE/MONGO connection string.");
	await mongoose.connect(database, { autoIndex: false });

	const cancellationPlans = [];
	for (const target of CANCELLATIONS) {
		// Deliberately serial: every target is asserted and reviewed independently.
		// eslint-disable-next-line no-await-in-loop
		cancellationPlans.push(await loadExactCancellationPlan(target));
	}
	const hotelPlan = await loadHotelAssignmentPlan();
	const targetReservationIds = [
		...cancellationPlans.map((plan) => plan.reservation._id),
		hotelPlan.reservation._id,
	];
	const targetAuditIds = [
		...CANCELLATIONS.map((target) => target.auditId),
		HOTEL_ASSIGNMENT.auditId,
	];
	const planSummary = {
		mode: APPLY ? "apply" : "dry-run",
		cancellations: cancellationPlans.map((plan) => ({
			auditId: id(plan.audit._id),
			reservationId: id(plan.reservation._id),
			provider: plan.target.provider,
			confirmationNumber: plan.target.confirmationNumber,
			currentStatus: plan.reservation.reservation_status,
			receivedAt: plan.audit.receivedAt,
		})),
		hotelAssignment: {
			auditId: id(hotelPlan.audit._id),
			reservationId: id(hotelPlan.reservation._id),
			otaHotelName: hotelPlan.normalized.hotelName,
			currentHotelId: id(hotelPlan.reservation.hotelId),
			resolvedHotelId: id(hotelPlan.hotel._id),
			resolvedHotelName: hotelPlan.hotel.hotelName,
		},
	};
	console.log(JSON.stringify(planSummary, null, 2));
	if (!APPLY) return;

	const beforeSnapshot = writeSnapshot("before", {
		createdAt: new Date(),
		plan: planSummary,
		reservations: await Reservations.find({
			_id: { $in: targetReservationIds },
		}).lean(),
		audits: await InboundEmail.find({ _id: { $in: targetAuditIds } }).lean(),
	});
	console.log(`Before snapshot: ${beforeSnapshot}`);

	const assigned = await applyHotelAssignment(hotelPlan);
	const cancellationResults = [];
	for (const plan of cancellationPlans) {
		// eslint-disable-next-line no-await-in-loop
		const result = await applyCancellation(plan);
		cancellationResults.push({
			confirmationNumber: plan.target.confirmationNumber,
			reservationId: id(result.updated._id),
			status: result.updated.reservation_status,
		});
	}

	const afterSnapshot = writeSnapshot("after", {
		createdAt: new Date(),
		beforeSnapshot,
		reservations: await Reservations.find({
			_id: { $in: targetReservationIds },
		}).lean(),
		audits: await InboundEmail.find({ _id: { $in: targetAuditIds } }).lean(),
	});
	console.log(`After snapshot: ${afterSnapshot}`);
	console.log(
		JSON.stringify(
			{
				success: true,
				hotelAssignment: {
					reservationId: id(assigned._id),
					hotelId: id(assigned.hotelId),
					status: assigned.reservation_status,
				},
				cancellations: cancellationResults,
			},
			null,
			2
		)
	);
}

main()
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(async () => {
		if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
	});
