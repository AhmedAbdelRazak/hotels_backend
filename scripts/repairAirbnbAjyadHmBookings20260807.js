/** @format */

"use strict";

require("dotenv").config();

const assert = require("node:assert/strict");
const mongoose = require("mongoose");

mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);
mongoose.set("strictQuery", true);

const HotelDetails = require("../models/hotel_details");
const InboundEmail = require("../models/inbound_email");
const Reservations = require("../models/reservations");
const { hashObject } = require("../services/hotelrunnerPayload");
const { hasDirectHotelRunnerProjection } = require("../services/hotelrunnerOtaEmailBoundary");
const {
	buildOtaConfirmationLookup,
	buildReservationDocument,
	extractNormalizedReservation,
	hashText,
	reconcileOtaReservation,
	requiredNewReservationMissing,
	trustedProviderFromSenderAddress,
} = require("../services/otaReservationMapper");
const {
	addReservationVersionBump,
	buildReservationSnapshotFilter,
} = require("../services/otaReviewConcurrency");

const REPAIR_ID = "airbnb-ajyad-hm-bookings-20260807-v1";
const HOTEL_ID = "6a40b6a1a6efe70450536038";
const WRITE_OPTIONS = Object.freeze({ writeConcern: { w: "majority" } });
const TARGETS = Object.freeze({
	hmzdmhqqre: Object.freeze({
		auditId: "6a75ff6b8e82560c40d648d3",
		reservationId: "6a76095b40ee00827997cbaf",
		roomId: "6a40e0981a6d1850eb25c27c",
		roomType: "tripleRooms",
		checkin: "2026-08-09",
		checkout: "2026-08-14",
		guestTotal: 370.01,
		payout: 271.88,
		otaCommission: 49.87,
		rootTotal: 375,
		dailyRoots: [75, 75, 75, 75, 75],
	}),
	hmpb4a4ew5: Object.freeze({
		auditId: "6a74b0065a7fc7b0fd450738",
		roomId: "6a4a84216022cd7f31729011",
		roomType: "familyRooms",
		checkin: "2026-08-06",
		checkout: "2026-08-08",
		guestTotal: 170.78,
		payout: 125.48,
		otaCommission: 23.02,
		rootTotal: 0,
		dailyRoots: [0, 0],
	}),
});

const id = (value) => String(value?._id || value || "");
const ymd = (value) => new Date(value).toISOString().slice(0, 10);
const matchedCount = (result = {}) => Number(result.matchedCount ?? result.n ?? 0);

function parseArguments(argv = process.argv.slice(2)) {
	const apply = argv.includes("--apply");
	const repairIndex = argv.indexOf("--repair-id");
	const planIndex = argv.indexOf("--plan-hash");
	const repairId = repairIndex >= 0 ? String(argv[repairIndex + 1] || "") : "";
	const planHash = planIndex >= 0 ? String(argv[planIndex + 1] || "") : "";
	if (apply) {
		assert.equal(repairId, REPAIR_ID, `--apply requires --repair-id ${REPAIR_ID}`);
		assert.match(planHash, /^[a-f0-9]{64}$/, "--apply requires the dry-run plan hash.");
	}
	return { apply, repairId, planHash };
}

function emailFromAudit(audit = {}) {
	const priorSource = audit.normalizedReservation?.source || {};
	const subject = String(audit.subject || "").replace(/\r/g, "").trim();
	const storedBody = String(audit.bodyText || "").replace(/\r/g, "");
	return {
		from: audit.from || "",
		to: audit.to || "",
		subject: audit.subject || "",
		text: storedBody.startsWith(`${subject}\n`)
			? storedBody.slice(subject.length + 1)
			: storedBody,
		html: audit.bodyHtml || "",
		messageId: audit.messageId || "",
		receivedAt: audit.receivedAt,
		sourceReceivedAt: priorSource.receivedAt || audit.receivedAt,
		sourceTimestampMethod: priorSource.timestampMethod || "",
		senderAuthentication: audit.senderAuthentication || {},
	};
}

function assertDirectAudit(audit, code, target) {
	assert.ok(audit, `Missing authenticated audit for ${code}.`);
	assert.equal(id(audit._id), target.auditId);
	assert.equal(audit.source, "sendgrid");
	assert.equal(audit.provider, "airbnb");
	assert.equal(audit.confirmationNumber, code);
	assert.ok(!audit.duplicateOf, `${code} direct audit unexpectedly became a duplicate.`);
	assert.notEqual(audit.emailContext?.forwarded, true, `${code} audit is forwarded.`);
	assert.equal(audit.senderAuthentication?.authenticatedAligned, true);
	assert.equal(audit.senderAuthentication?.trustedProvider, "airbnb");
	assert.equal(trustedProviderFromSenderAddress(audit.from || ""), "airbnb");
	assert.equal(hashText(audit.bodyText || ""), audit.textHash);
	assert.ok(Number.isInteger(audit.__v));
}

function parseTarget(audit, code, target, hotel) {
	const normalized = extractNormalizedReservation(emailFromAudit(audit));
	normalized.inboundEmailId = target.auditId;
	assert.equal(normalized.provider, "airbnb");
	assert.equal(normalized.confirmationNumber, code);
	assert.equal(normalized.intent, "new_reservation");
	assert.equal(normalized.eventType, "new");
	assert.equal(normalized.sourceSenderAuthenticated, true);
	assert.equal(normalized.requiresManualReview, false);
	assert.deepEqual(requiredNewReservationMissing(normalized), []);
	assert.equal(normalized.hotelId, HOTEL_ID);
	assert.equal(normalized.hotelIdMatchedBy, "standalone ajyad hotel segment");
	assert.equal(ymd(normalized.checkinDate), target.checkin);
	assert.equal(ymd(normalized.checkoutDate), target.checkout);
	assert.equal(Number(normalized.totalAmountSar), target.guestTotal);
	assert.equal(Number(normalized.totalPayoutSar), target.payout);
	assert.equal(Number(normalized.otaCommissionSar), target.otaCommission);
	assert.equal(normalized.otaCommissionSource, "airbnb_host_service_fee");
	assert.equal(normalized.sourcePresence?.otaCommission, true);

	const built = buildReservationDocument(normalized, hotel);
	assert.equal(built.ok, true, built.error || `Could not build ${code}.`);
	assertExpectedProjection(built.document, code, target);
	return { normalized, built: built.document };
}

function assertExpectedProjection(reservation, code, target) {
	assert.ok(reservation, `Missing reservation projection for ${code}.`);
	assert.equal(id(reservation.hotelId), HOTEL_ID);
	assert.equal(Number(reservation.total_amount), target.guestTotal);
	assert.equal(Number(reservation.sub_total), target.rootTotal);
	assert.equal(Number(reservation.commission || 0), 0);
	assert.equal(Number(reservation.commission_ota), target.otaCommission);
	assert.equal(ymd(reservation.checkin_date), target.checkin);
	assert.equal(ymd(reservation.checkout_date), target.checkout);
	const rooms = reservation.pickedRoomsType || [];
	assert.equal(rooms.length, 1);
	assert.equal(id(rooms[0].hotelRoomConfigId), target.roomId);
	assert.equal(rooms[0].room_type, target.roomType);
	assert.equal(Number(rooms[0].hotelShouldGet || 0), target.rootTotal);
	assert.deepEqual(
		(rooms[0].pricingByDay || []).map((day) => Number(day.rootPrice || 0)),
		target.dailyRoots
	);
	assert.ok((rooms[0].pricingByDay || []).every((day) => Number(day.commissionRate || 0) === 0));
	assert.deepEqual(reservation.pickedRoomsType, reservation.pickedRoomsPricing);
	assert.equal(Number(reservation.adminPricing?.rootTotal || 0), target.rootTotal);
	assert.equal(Number(reservation.adminPricing?.commissionAmount || 0), 0);
	assert.equal(
		Number(reservation.ota_financial_summary?.hotelVisibleAmount || 0),
		target.rootTotal
	);
	assert.equal(Number(reservation.ota_financial_summary?.commissionAmount || 0), 0);
	assert.equal(Number(reservation.financial_cycle?.commissionValue || 0), 0);
	assert.equal(Number(reservation.financial_cycle?.commissionAmount || 0), 0);
	assert.equal(
		Number(reservation.financial_cycle?.hotelPayoutDue || 0),
		target.rootTotal
	);
	assert.equal(id(reservation.supplierData?.otaHotelRoomConfigId), target.roomId);
	assert.equal(Number(reservation.supplierData?.otaCommissionSar), target.otaCommission);
	assert.equal(
		reservation.supplierData?.otaCommissionSource,
		"airbnb_host_service_fee"
	);
	assert.equal(reservation.supplierData?.otaCommissionSourceBacked, true);
}

async function exactReservations(code) {
	return Reservations.find(buildOtaConfirmationLookup(code, "airbnb")).lean().exec();
}

function stableProjection(document, target) {
	return {
		hotelId: id(document.hotelId),
		roomId: id(document.pickedRoomsType?.[0]?.hotelRoomConfigId),
		roomType: document.pickedRoomsType?.[0]?.room_type || "",
		rootTotal: Number(document.sub_total || 0),
		guestTotal: Number(document.total_amount || 0),
		legacyCommission: Number(document.commission || 0),
		otaCommission: Number(document.commission_ota),
		hotelPayoutDue: Number(document.financial_cycle?.hotelPayoutDue || 0),
		dailyRoots: (document.pickedRoomsType?.[0]?.pricingByDay || []).map((day) =>
			Number(day.rootPrice || 0)
		),
		expectedRoomId: target.roomId,
	};
}

function assertHmZMutableState(existing) {
	const target = TARGETS.hmzdmhqqre;
	assert.equal(id(existing._id), target.reservationId);
	assert.equal(id(existing.hotelId), HOTEL_ID);
	assert.equal(existing.state, "pending confirmation");
	assert.equal(existing.reservation_status, "pending confirmation");
	assert.equal(existing.pendingConfirmation?.status, "pending");
	assert.equal(existing.otaPlatformReview?.status, "released");
	assert.equal(id(existing.supplierData?.otaInboundEmailId), target.auditId);
	assert.equal(hasDirectHotelRunnerProjection(existing), false);
	assert.deepEqual(existing.roomId || [], []);
	assert.notEqual(existing.payment_details?.captured, true);
	assert.notEqual(existing.moneyTransferredToHotel, true);
	assert.notEqual(existing.commissionPaid, true);
	assert.equal(Number(existing.total_amount), target.guestTotal);
	assert.equal(ymd(existing.checkin_date), target.checkin);
	assert.equal(ymd(existing.checkout_date), target.checkout);
}

function hmzCorrectionSet(existing, built, appliedAt) {
	const target = TARGETS.hmzdmhqqre;
	return {
		sub_total: built.sub_total,
		commission: 0,
		commission_ota: built.commission_ota,
		pickedRoomsType: built.pickedRoomsType,
		pickedRoomsPricing: built.pickedRoomsPricing,
		adminPricing: {
			...(existing.adminPricing || {}),
			rootTotal: built.adminPricing.rootTotal,
			platformMarginTotal: built.adminPricing.platformMarginTotal,
			commissionAmount: 0,
			roomIdentityMode: "pms_configured",
		},
		ota_financial_summary: {
			...(existing.ota_financial_summary || {}),
			hotelVisibleAmount: built.ota_financial_summary.hotelVisibleAmount,
			platformProfit: built.ota_financial_summary.platformProfit,
			commissionAmount: 0,
		},
		financial_cycle: {
			...(existing.financial_cycle || {}),
			commissionValue: 0,
			commissionAmount: 0,
			hotelPayoutDue: target.rootTotal,
			commissionDueToPms: 0,
		},
		"supplierData.otaMatchedRoomName": built.supplierData.otaMatchedRoomName,
		"supplierData.otaHotelRoomConfigId": built.supplierData.otaHotelRoomConfigId,
		"supplierData.otaSourceRoomName": built.supplierData.otaSourceRoomName,
		"supplierData.otaRoomMatchScore": built.supplierData.otaRoomMatchScore,
		"supplierData.otaRoomMatchType": built.supplierData.otaRoomMatchType,
		"supplierData.otaRoomMappingRequired": false,
		"supplierData.otaCommissionSar": built.supplierData.otaCommissionSar,
		"supplierData.otaCommissionSource": built.supplierData.otaCommissionSource,
		"supplierData.otaCommissionSourceBacked": true,
		"supplierData.otaAirbnbAjyadRepairId": REPAIR_ID,
		"otaPlatformReview.postReleasePricingCorrection": {
			repairId: REPAIR_ID,
			appliedAt,
			sourceInboundEmailId: target.auditId,
			previousHotelTotalSar: Number(existing.sub_total || 0),
			correctedHotelTotalSar: target.rootTotal,
			roomConfigId: target.roomId,
			legacyCommissionSar: 0,
			otaCommissionSar: target.otaCommission,
		},
	};
}

function hmpAuditSet(audit, normalized, reconciliation, reservation, appliedAt) {
	return {
		provider: "airbnb",
		providerLabel: "Airbnb",
		intent: normalized.intent,
		eventType: normalized.eventType,
		processingStatus: "created",
		confirmationNumber: "hmpb4a4ew5",
		pmsConfirmationNumber: reconciliation.pmsConfirmationNumber || "",
		hotelName: normalized.hotelName || "",
		roomName: normalized.roomName || "",
		sourceAmount: Number(normalized.amount || 0),
		sourceCurrency: normalized.currency || "",
		totalAmountSar: Number(normalized.totalAmountSar || 0),
		exchangeRateToSar: Number(normalized.exchangeRateToSar || 0),
		exchangeRateSource: normalized.exchangeRateSource || "",
		paymentCollectionModel: normalized.paymentCollectionModel || "",
		hotelId: reservation.hotelId,
		reservationMongoId: reservation._id,
		hasReservationConnection: true,
		matchedReservationBy: reconciliation.matchedReservationBy || [],
		automationAction: "created",
		skipReason: "",
		automationComment:
			"Authenticated Airbnb booking recovered after the stay-date parser and standalone Ajyad mapping fixes; saved once in OTA Platform Review.",
		normalizedReservation: normalized,
		orchestratorDecision: {
			usedAI: false,
			skipped: true,
			skipReason: "deterministic_airbnb_ajyad_recovery",
			repairId: REPAIR_ID,
		},
		reconciliation: {
			...reconciliation,
			repairId: REPAIR_ID,
			recoveredFromInboundAudit: true,
		},
		parseWarnings: normalized.warnings || [],
		parseErrors: normalized.errors || [],
		reconcileWarnings: reconciliation.warnings || [],
		reconcileErrors: reconciliation.errors || [],
		processedAt: appliedAt,
	};
}

async function loadPlan() {
	const hotel = await HotelDetails.findById(HOTEL_ID).lean();
	assert.ok(hotel, "Zad Ajyad hotel is missing.");
	assert.equal(id(hotel._id), HOTEL_ID);
	assert.equal(hotel.activateHotel, true);
	assert.notEqual(hotel.xHotelProActive, false);

	const audits = {};
	const parsed = {};
	const matches = {};
	for (const [code, target] of Object.entries(TARGETS)) {
		audits[code] = await InboundEmail.findById(target.auditId).lean();
		assertDirectAudit(audits[code], code, target);
		parsed[code] = parseTarget(audits[code], code, target, hotel);
		matches[code] = await exactReservations(code);
		assert.ok(matches[code].length <= 1, `${code} has duplicate PMS reservations.`);
	}
	assert.equal(matches.hmzdmhqqre.length, 1, "Safwan reservation is missing.");
	assertHmZMutableState(matches.hmzdmhqqre[0]);
	if (matches.hmpb4a4ew5.length === 1) {
		assertExpectedProjection(
			matches.hmpb4a4ew5[0],
			"hmpb4a4ew5",
			TARGETS.hmpb4a4ew5
		);
	}

	const hashInput = {
		repairId: REPAIR_ID,
		hotelId: HOTEL_ID,
		hotelVersion: hotel.__v,
		hotelUpdatedAt: hotel.updatedAt,
		audits: Object.fromEntries(
			Object.entries(audits).map(([code, audit]) => [
				code,
				{
					id: id(audit._id),
					version: audit.__v,
					updatedAt: audit.updatedAt,
					textHash: audit.textHash,
					processingStatus: audit.processingStatus,
					skipReason: audit.skipReason,
					reservationMongoId: id(audit.reservationMongoId),
				},
			])
		),
		hmzExisting: {
			id: id(matches.hmzdmhqqre[0]._id),
			version: matches.hmzdmhqqre[0].__v,
			updatedAt: matches.hmzdmhqqre[0].updatedAt,
			projection: stableProjection(matches.hmzdmhqqre[0], TARGETS.hmzdmhqqre),
			state: matches.hmzdmhqqre[0].state,
			status: matches.hmzdmhqqre[0].reservation_status,
			reviewStatus: matches.hmzdmhqqre[0].otaPlatformReview?.status,
		},
		hmpExistingCount: matches.hmpb4a4ew5.length,
		expected: Object.fromEntries(
			Object.entries(parsed).map(([code, value]) => [
				code,
				stableProjection(value.built, TARGETS[code]),
			])
		),
	};
	return {
		hotel,
		audits,
		parsed,
		matches,
		planHash: hashObject(hashInput),
	};
}

async function applyHmZ(plan, appliedAt) {
	const existing = plan.matches.hmzdmhqqre[0];
	const target = TARGETS.hmzdmhqqre;
	const set = hmzCorrectionSet(existing, plan.parsed.hmzdmhqqre.built, appliedAt);
	const filter = {
		...buildReservationSnapshotFilter(existing, {
			expectedReviewStatus: "released",
			includeHotel: true,
		}),
		state: existing.state,
		reservation_status: existing.reservation_status,
		"pendingConfirmation.status": existing.pendingConfirmation?.status,
		"supplierData.otaInboundEmailId": target.auditId,
		total_amount: existing.total_amount,
		sub_total: existing.sub_total,
		commission: existing.commission,
		commission_ota: existing.commission_ota ?? null,
	};
	const result = await Reservations.updateOne(
		filter,
		addReservationVersionBump({ $set: set }),
		WRITE_OPTIONS
	);
	if (matchedCount(result) !== 1) {
		const live = await Reservations.findById(target.reservationId).lean();
		assertExpectedProjection(live, "hmzdmhqqre", target);
		return live;
	}
	const live = await Reservations.findById(target.reservationId).lean();
	assertExpectedProjection(live, "hmzdmhqqre", target);
	assert.equal(live.state, existing.state);
	assert.equal(live.reservation_status, existing.reservation_status);
	assert.equal(live.pendingConfirmation?.status, existing.pendingConfirmation?.status);
	assert.equal(live.otaPlatformReview?.status, existing.otaPlatformReview?.status);
	assert.equal(live.otaPlatformReview?.priceAtRelease, existing.otaPlatformReview?.priceAtRelease);
	assert.deepEqual(live.roomId || [], existing.roomId || []);
	return live;
}

async function applyHmP(plan, appliedAt) {
	const target = TARGETS.hmpb4a4ew5;
	let reconciliation = null;
	if (!plan.matches.hmpb4a4ew5.length) {
		const externalKeys = [
			"OPENAI_API_KEY",
			"OPENAI_KEY",
			"CHATGPT_API_KEY",
			"EXCHANGE_RATE_API_KEY",
			"EXCHANGERATE_API_KEY",
		];
		const saved = Object.fromEntries(externalKeys.map((key) => [key, process.env[key]]));
		for (const key of externalKeys) delete process.env[key];
		const originalFetch = global.fetch;
		let externalAttempts = 0;
		global.fetch = async () => {
			externalAttempts += 1;
			throw new Error("External HTTP is disabled for this repair.");
		};
		try {
			reconciliation = await reconcileOtaReservation(
				plan.parsed.hmpb4a4ew5.normalized
			);
		} finally {
			global.fetch = originalFetch;
			for (const key of externalKeys) {
				if (saved[key] === undefined) delete process.env[key];
				else process.env[key] = saved[key];
			}
		}
		assert.equal(externalAttempts, 0, "Repair attempted an external HTTP call.");
		assert.ok(
			["created", "duplicate_reservation"].includes(reconciliation.status),
			`Unexpected HMP reconciliation status: ${reconciliation.status}`
		);
	}
	const matches = await exactReservations("hmpb4a4ew5");
	assert.equal(matches.length, 1, "HMP recovery did not leave exactly one reservation.");
	const reservation = matches[0];
	assertExpectedProjection(reservation, "hmpb4a4ew5", target);
	assert.equal(reservation.state, "OTA Platform Review");
	assert.equal(reservation.reservation_status, "OTA Platform Review");
	assert.equal(reservation.otaPlatformReview?.status, "pending");

	const audit = await InboundEmail.findById(target.auditId).lean();
	if (audit.reconciliation?.repairId !== REPAIR_ID) {
		assert.equal(audit.processingStatus, "needs_review");
		assert.equal(audit.skipReason, "ota_parser_requires_manual_review");
		assert.ok(!audit.reservationMongoId);
		const fallbackReconciliation = reconciliation || {
			status: "duplicate_reservation",
			actionTaken: "skipped",
			skipReason: "duplicate_existing_reservation_no_update",
			reservationId: id(reservation._id),
			pmsConfirmationNumber: reservation.confirmation_number || "",
			matchedReservationBy: ["otaIdentityKey"],
			warnings: [],
			errors: [],
		};
		const auditResult = await InboundEmail.updateOne(
			{
				_id: target.auditId,
				__v: audit.__v,
				textHash: audit.textHash,
				processingStatus: "needs_review",
				skipReason: "ota_parser_requires_manual_review",
				reservationMongoId: null,
				"senderAuthentication.authenticatedAligned": true,
				"senderAuthentication.trustedProvider": "airbnb",
			},
			addReservationVersionBump({
				$set: hmpAuditSet(
					audit,
					plan.parsed.hmpb4a4ew5.normalized,
					fallbackReconciliation,
					reservation,
					appliedAt
				),
			}),
			WRITE_OPTIONS
		);
		assert.equal(matchedCount(auditResult), 1, "HMP audit CAS was not acquired.");
	}
	const finalAudit = await InboundEmail.findById(target.auditId).lean();
	assert.equal(id(finalAudit.reservationMongoId), id(reservation._id));
	assert.equal(finalAudit.processingStatus, "created");
	assert.equal(finalAudit.reconciliation?.repairId, REPAIR_ID);
	return reservation;
}

async function run(args = parseArguments()) {
	const database = process.env.DATABASE || process.env.MONGO_URI || process.env.MONGODB_URI;
	assert.ok(database, "Missing DATABASE/MONGO connection string.");
	await mongoose.connect(database, { autoIndex: false });
	const plan = await loadPlan();
	if (args.apply) assert.equal(args.planHash, plan.planHash, "Dry-run plan hash changed.");
	const publicPlan = {
		mode: args.apply ? "apply" : "dry-run",
		repairId: REPAIR_ID,
		planHash: plan.planHash,
		hotelId: HOTEL_ID,
		targets: {
			hmzdmhqqre: {
				reservationCount: plan.matches.hmzdmhqqre.length,
				action: "preserve released lifecycle; correct PMS room, hotel total, and commission fields",
				expectedRoomId: TARGETS.hmzdmhqqre.roomId,
				expectedHotelTotalSar: TARGETS.hmzdmhqqre.rootTotal,
			},
			hmpb4a4ew5: {
				reservationCount: plan.matches.hmpb4a4ew5.length,
				action: plan.matches.hmpb4a4ew5.length
					? "verify and link exact existing reservation"
					: "create exactly one mapped OTA Platform Review reservation",
				expectedRoomId: TARGETS.hmpb4a4ew5.roomId,
				expectedHotelTotalSar: TARGETS.hmpb4a4ew5.rootTotal,
			},
		},
		externalApiCalls: 0,
		hotelRunnerApiCalls: 0,
	};
	console.log(JSON.stringify(publicPlan, null, 2));
	if (!args.apply) return publicPlan;

	const appliedAt = new Date();
	const hmp = await applyHmP(plan, appliedAt);
	const hmz = await applyHmZ(plan, appliedAt);
	const result = {
		...publicPlan,
		success: true,
		exactReservationCounts: {
			hmzdmhqqre: (await exactReservations("hmzdmhqqre")).length,
			hmpb4a4ew5: (await exactReservations("hmpb4a4ew5")).length,
		},
		reservations: {
			hmzdmhqqre: id(hmz._id),
			hmpb4a4ew5: id(hmp._id),
		},
		externalApiCalls: 0,
		hotelRunnerApiCalls: 0,
	};
	console.log(JSON.stringify(result, null, 2));
	return result;
}

if (require.main === module) {
	run()
		.catch((error) => {
			console.error(error.message);
			process.exitCode = 1;
		})
		.finally(async () => {
			if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
		});
}

module.exports = {
	HOTEL_ID,
	REPAIR_ID,
	TARGETS,
	assertExpectedProjection,
	emailFromAudit,
	hmzCorrectionSet,
	parseArguments,
	run,
};
