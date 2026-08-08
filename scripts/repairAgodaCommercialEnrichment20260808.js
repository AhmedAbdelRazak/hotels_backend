/** @format */

"use strict";

const crypto = require("crypto");
const { execFileSync } = require("child_process");
const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const mongoose = require("mongoose");

// A bounded repair must never create or rebuild indexes on the live PMS database.
mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);

const HotelDetails = require("../models/hotel_details");
const HotelRunnerEvent = require("../models/hotelrunner_event");
const HotelRunnerReservation = require("../models/hotelrunner_reservation");
const InboundEmail = require("../models/inbound_email");
const Reservations = require("../models/reservations");
const {
	applyUpdateToDocument,
	buildExactCasFilter,
	canonicalEjsonSha256,
	cloneBson,
} = require("../services/recentOtaInboundRecovery20260805");
const {
	buildHotelRunnerEmailCommercialEvidence,
	directHotelRunnerCommercialEnrichmentSet,
	directHotelRunnerEmailCommercialGuard,
	extractNormalizedReservation,
	verifiedHotelRunnerEmailCommercialEvidence,
} = require("../services/otaReservationMapper");
const { hashObject, stableClone } = require("../services/hotelrunnerPayload");

const REPAIR_ID = "agoda-commercial-enrichment-20260808-v1";
const EXPECTED_HOTEL_ID = "6a40b6a1a6efe70450536038";
const EXPECTED_HOTEL_NAME_KEY = "zadajyad";
const PROOF_MAX_AGE_MS = 30 * 60 * 1000;
const TRANSACTION_APPLY_STRATEGY = "snapshot_transaction";
const STANDALONE_APPLY_STRATEGY = "serialized_full_document_cas";
const APPLY_STRATEGIES = new Set([
	TRANSACTION_APPLY_STRATEGY,
	STANDALONE_APPLY_STRATEGY,
]);

const EXACT_TARGETS = Object.freeze(
	[
		{
			key: "agoda_687715051",
			requestedIdentifier: "687715051",
			otaBookingId: "687715051",
			pmsConfirmationNumber: "4097979349",
			reservationMongoId: "6a77a0ebde7b4b5990aba1ac",
			reservationVersion: 0,
			hotelRunnerReservationId: "40369350",
			hrNumber: "R178704171",
			eventId: "6a77a0ead8cbed2f4bad4716",
			eventPayloadHash:
				"33083669b9ee577aa3c05ccadfa99c9c281bda80f0e7711203cb9129bd2f1258",
			canonicalHash:
				"1077b8adf2cbf62b487093022871fd892ac903ee7ee04b8c679bbbf9a4beaff2",
			eventStatus: "completed",
			mirrorId: "6a77a0ebde7b4b5990aba1a3",
			inboundEmailId: "6a77a0e3bf632980ba061c1f",
			bodyTextHash:
				"3c34248b2b54f1a7af43a895a1c56f13326a8718eab878d22a4a09c9efa8e719",
			checkinDate: "2026-08-09",
			checkoutDate: "2026-08-11",
			roomConfigId: "6a40e45a1a6d1850eb25c58b",
			sourceRoomName:
				"Deluxe Family Room 2 - Non-Refundable - 2 Occupancy - NR",
			parsedRoomName: "Deluxe Family Room 2",
			grossTotalSar: 172.48,
			rootTotalSar: 150,
			payoutTotalSar: 106.74,
			otaExpenseTotalSar: 65.74,
			otaCommissionSar: 25.88,
			componentAmounts: [25.88, 17.24, 6.46],
			unclassifiedDeductionSar: 16.16,
			dailyClient: [86.24, 86.24],
			dailyRoot: [75, 75],
			dailyPayout: [53.37, 53.37],
			dailyExpense: [32.87, 32.87],
			dailyMargin: [-21.63, -21.63],
		},
		{
			key: "agoda_pms_9730513055",
			requestedIdentifier: "9730513055",
			otaBookingId: "687702587",
			pmsConfirmationNumber: "9730513055",
			reservationMongoId: "6a779578de7b4b5990ab9625",
			reservationVersion: 0,
			hotelRunnerReservationId: "40368675",
			hrNumber: "R483293997",
			eventId: "6a779577d8cbed2f4bad4715",
			eventPayloadHash:
				"994b742329e13e934314255b21731693dc34c731aaca5eb570c16bc1a467312d",
			canonicalHash:
				"c8b60c0efacb9b0037a9768a4dadd7654457bdadcb86336a0bc735bc038eaf6e",
			eventStatus: "attention",
			mirrorId: "6a779578de7b4b5990ab961c",
			inboundEmailId: "6a779560bf632980ba0610e2",
			bodyTextHash:
				"239387434427d90469d147e513019e6ff7dfede701ce3024f477d79921ab1218",
			checkinDate: "2026-08-08",
			checkoutDate: "2026-08-09",
			roomConfigId: "6a40e0981a6d1850eb25c27c",
			sourceRoomName:
				"Triple Bed Room With Air Conditioning - Room Only - 3 Occupancy",
			parsedRoomName: "Triple Bed Room With Air Conditioning",
			grossTotalSar: 80,
			rootTotalSar: 75,
			payoutTotalSar: 49.5,
			otaExpenseTotalSar: 30.5,
			otaCommissionSar: 12,
			componentAmounts: [12, 8, 3],
			unclassifiedDeductionSar: 7.5,
			dailyClient: [80],
			dailyRoot: [75],
			dailyPayout: [49.5],
			dailyExpense: [30.5],
			dailyMargin: [-25.5],
		},
	].map((target) => Object.freeze(target))
);

const clean = (value = "") => String(value?._id || value || "").trim();
const lower = (value = "") => clean(value).toLowerCase();
const upper = (value = "") => clean(value).toUpperCase();
const round2 = (value) => Number(Number(value).toFixed(2));
const sha256 = (value) =>
	crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
const dateKey = (value) => {
	const parsed = value instanceof Date ? value : new Date(value);
	return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : "";
};

function fail(message, code = "AGODA_COMMERCIAL_REPAIR_BLOCKED") {
	const error = new Error(message);
	error.code = code;
	throw error;
}

function parseArguments(argv = []) {
	let apply = false;
	let repairId = "";
	let releaseSha = "";
	let proof = "";
	for (const raw of argv) {
		const argument = clean(raw);
		if (argument === "--apply") {
			if (apply) fail("--apply may be supplied only once.", "AGODA_REPAIR_ARGUMENT_INVALID");
			apply = true;
			continue;
		}
		for (const [prefix, prior, assign] of [
			["--repair-id=", repairId, (value) => (repairId = value)],
			["--release-sha=", releaseSha, (value) => (releaseSha = lower(value))],
			["--proof=", proof, (value) => (proof = lower(value))],
		]) {
			if (!argument.startsWith(prefix)) continue;
			if (prior) fail(`${prefix.slice(0, -1)} may be supplied only once.`, "AGODA_REPAIR_ARGUMENT_INVALID");
			assign(argument.slice(prefix.length));
			break;
		}
		if (
			argument === "--apply" ||
			argument.startsWith("--repair-id=") ||
			argument.startsWith("--release-sha=") ||
			argument.startsWith("--proof=")
		) {
			continue;
		}
		fail("Unsupported Agoda commercial repair argument.", "AGODA_REPAIR_ARGUMENT_INVALID");
	}
	if (!/^[a-f0-9]{40}$/.test(releaseSha)) {
		fail("An exact 40-character --release-sha is required.", "AGODA_REPAIR_RELEASE_REQUIRED");
	}
	if (!apply && (repairId || proof)) {
		fail("--repair-id and --proof are apply-only arguments.", "AGODA_REPAIR_ARGUMENT_INVALID");
	}
	if (apply && repairId !== REPAIR_ID) {
		fail(`Apply requires --repair-id=${REPAIR_ID}.`, "AGODA_REPAIR_ID_REQUIRED");
	}
	if (apply && !/^\d{13}\.[a-f0-9]{64}$/.test(proof)) {
		fail("Apply requires the exact unexpired dry-run proof.", "AGODA_REPAIR_PROOF_REQUIRED");
	}
	return { apply, repairId, releaseSha, proof };
}

function currentReleaseSha(repoRoot = path.resolve(__dirname, "..")) {
	try {
		return lower(
			execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: repoRoot,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			})
		);
	} catch (_error) {
		fail("Could not resolve the deployed Git release SHA.", "AGODA_REPAIR_RELEASE_UNRESOLVED");
	}
}

function assertRelease(expected, actual) {
	if (!/^[a-f0-9]{40}$/.test(lower(actual)) || lower(actual) !== lower(expected)) {
		fail("The deployed checkout does not equal the explicitly approved merge SHA.", "AGODA_REPAIR_RELEASE_MISMATCH");
	}
}

async function resolveApplyStrategy(admin = mongoose.connection.db?.admin()) {
	if (!admin || typeof admin.command !== "function") {
		fail("MongoDB topology could not be inspected before planning.", "AGODA_REPAIR_TOPOLOGY_UNKNOWN");
	}
	const hello = await admin.command({ hello: 1 });
	if (hello?.isWritablePrimary !== true && hello?.ismaster !== true) {
		fail("The repair must be connected to the writable primary.", "AGODA_REPAIR_PRIMARY_REQUIRED");
	}
	return hello?.setName || hello?.msg === "isdbgrid"
		? TRANSACTION_APPLY_STRATEGY
		: STANDALONE_APPLY_STRATEGY;
}

function parseProof(proof, now = new Date()) {
	const match = lower(proof).match(/^(\d{13})\.([a-f0-9]{64})$/);
	if (!match) fail("The dry-run proof format is invalid.", "AGODA_REPAIR_PROOF_INVALID");
	const plannedAtMs = Number(match[1]);
	const nowMs = now.getTime();
	if (
		!Number.isSafeInteger(plannedAtMs) ||
		plannedAtMs > nowMs + 5_000 ||
		nowMs - plannedAtMs > PROOF_MAX_AGE_MS
	) {
		fail("The dry-run proof is expired or from the future.", "AGODA_REPAIR_PROOF_EXPIRED");
	}
	return { plannedAt: new Date(plannedAtMs), planHash: match[2] };
}

function reservationLookup(target) {
	const identity = `agoda:${target.otaBookingId}`;
	return {
		hotelId: EXPECTED_HOTEL_ID,
		$or: [
			{ _id: target.reservationMongoId },
			{ confirmation_number: target.pmsConfirmationNumber },
			{ otaIdentityKey: identity },
			{ otaCrossTransportIdentityKey: identity },
			{ reservation_id: target.otaBookingId },
			{ "customer_details.confirmation_number2": target.otaBookingId },
			{ "supplierData.otaConfirmationNumber": target.otaBookingId },
			{ "supplierData.platformConfirmationNumber": target.otaBookingId },
			{ "supplierData.hotelRunner.reservationId": target.hotelRunnerReservationId },
		],
	};
}

async function leanMany(Model, filter, { session = null, limit = 3, select = "" } = {}) {
	let query = Model.find(filter);
	if (select && typeof query.select === "function") query = query.select(select);
	if (typeof query.limit === "function") query = query.limit(limit);
	if (session && typeof query.session === "function") query = query.session(session);
	if (!session && typeof query.read === "function") query = query.read("primary");
	if (!session && typeof query.readConcern === "function") query = query.readConcern("majority");
	if (typeof query.lean === "function") query = query.lean();
	return query && typeof query.exec === "function" ? query.exec() : query;
}

async function leanOne(Model, filter, options = {}) {
	const values = await leanMany(Model, filter, { ...options, limit: 2 });
	if (!Array.isArray(values) || values.length !== 1) return null;
	return values[0];
}

function assertHotel(hotel) {
	const nameKey = lower(hotel?.hotelName).replace(/[^a-z0-9]+/g, "");
	if (
		clean(hotel?._id) !== EXPECTED_HOTEL_ID ||
		nameKey !== EXPECTED_HOTEL_NAME_KEY ||
		hotel?.activateHotel !== true ||
		hotel?.xHotelProActive === false
	) {
		fail("The exact active Zad Ajyad hotel boundary is not satisfied.");
	}
}

function assertEnvelope(target, event, mirror, audit) {
	if (
		clean(event?._id) !== target.eventId ||
		clean(event?.hotelId) !== EXPECTED_HOTEL_ID ||
		clean(event?.hotelRunnerReservationId) !== target.hotelRunnerReservationId ||
		upper(event?.hrNumber) !== target.hrNumber ||
		clean(event?.providerNumber) !== target.otaBookingId ||
		lower(event?.source) !== "push" ||
		lower(event?.status) !== target.eventStatus ||
		clean(event?.payloadHash) !== target.eventPayloadHash ||
		clean(event?.canonicalHash) !== target.canonicalHash ||
		clean(event?.reservationMongoId) !== target.reservationMongoId ||
		event?.integrityConflict === true ||
		clean(event?.integrityReason)
	) {
		fail(`${target.key} HotelRunner event immutable proof changed.`);
	}
	if (
		clean(mirror?._id) !== target.mirrorId ||
		clean(mirror?.hotelId) !== EXPECTED_HOTEL_ID ||
		clean(mirror?.hotelRunnerReservationId) !== target.hotelRunnerReservationId ||
		upper(mirror?.hrNumber) !== target.hrNumber ||
		clean(mirror?.providerNumber) !== target.otaBookingId ||
		clean(mirror?.observedCanonicalHash) !== target.canonicalHash ||
		clean(mirror?.appliedCanonicalHash) !== target.canonicalHash ||
		Number(mirror?.projectionVersion) !== 1 ||
		clean(mirror?.reservationMongoId) !== target.reservationMongoId
	) {
		fail(`${target.key} HotelRunner mirror immutable proof changed.`);
	}
	if (
		clean(audit?._id) !== target.inboundEmailId ||
		lower(audit?.provider) !== "agoda" ||
		clean(audit?.confirmationNumber) !== target.otaBookingId ||
		audit?.senderAuthentication?.authenticatedAligned !== true ||
		lower(audit?.senderAuthentication?.trustedProvider) !== "agoda" ||
		clean(audit?.textHash) !== target.bodyTextHash ||
		sha256(audit?.bodyText) !== target.bodyTextHash
	) {
		fail(`${target.key} authenticated Agoda audit immutable proof changed.`);
	}
}

function roomIdentityProjection(rooms = []) {
	return (Array.isArray(rooms) ? rooms : []).map((room) => ({
		room_type: room?.room_type,
		displayName: room?.displayName,
		sourceRoomName: room?.sourceRoomName,
		hotelRoomConfigId: clean(room?.hotelRoomConfigId),
		localRoomConfigId: clean(room?.localRoomConfigId),
		count: Number(room?.count || 1),
		pricingByDay: (Array.isArray(room?.pricingByDay) ? room.pricingByDay : []).map(
			(day) => ({
				date: dateKey(day?.date),
				rootPrice: round2(day?.rootPrice),
				hotelRunnerSourcePrice: round2(day?.hotelRunnerSourcePrice),
			})
		),
	}));
}

function protectedReservationSnapshot(reservation = {}) {
	return stableClone({
		_id: clean(reservation._id),
		hotelId: clean(reservation.hotelId),
		belongsTo: clean(reservation.belongsTo),
		confirmation_number: reservation.confirmation_number,
		reservation_id: reservation.reservation_id,
		hr_number: reservation.hr_number,
		otaIdentityKey: reservation.otaIdentityKey,
		otaCrossTransportIdentityKey: reservation.otaCrossTransportIdentityKey,
		booking_source: reservation.booking_source,
		customer_details: reservation.customer_details,
		state: reservation.state,
		reservation_status: reservation.reservation_status,
		checkin_date: dateKey(reservation.checkin_date),
		checkout_date: dateKey(reservation.checkout_date),
		total_rooms: reservation.total_rooms,
		total_guests: reservation.total_guests,
		adults: reservation.adults,
		children: reservation.children,
		roomId: reservation.roomId,
		bedNumber: reservation.bedNumber,
		roomIdentity: roomIdentityProjection(reservation.pickedRoomsPricing),
		sub_total: reservation.sub_total,
		rootTotal: reservation.adminPricing?.rootTotal,
		hotelVisibleAmount: reservation.ota_financial_summary?.hotelVisibleAmount,
		commission: reservation.commission,
		financeStatus: reservation.financeStatus,
		payment: reservation.payment,
		paid_amount: reservation.paid_amount,
		payment_details: reservation.payment_details,
		paid_amount_breakdown: reservation.paid_amount_breakdown,
		financialCycle: reservation.financialCycle,
		otaPlatformReview: reservation.otaPlatformReview,
		adminPricingVisibility: reservation.adminPricingVisibility,
		pendingConfirmation: reservation.pendingConfirmation,
		hotelRunner: reservation.supplierData?.hotelRunner,
		otaAutomationPipeline: reservation.supplierData?.otaAutomationPipeline,
		otaSourceAuthority: reservation.supplierData?.otaSourceAuthority,
	});
}

function applyDottedSet(document, set = {}) {
	const next = cloneBson(document);
	for (const [pathText, value] of Object.entries(set)) {
		const parts = pathText.split(".");
		let current = next;
		for (const part of parts.slice(0, -1)) {
			current[part] ||= {};
			current = current[part];
		}
		current[parts.at(-1)] = cloneBson(value);
	}
	return next;
}

function assertReservationBoundary(target, reservation) {
	const identity = `agoda:${target.otaBookingId}`;
	const rooms = roomIdentityProjection(reservation?.pickedRoomsPricing);
	if (
		clean(reservation?._id) !== target.reservationMongoId ||
		clean(reservation?.hotelId) !== EXPECTED_HOTEL_ID ||
		clean(reservation?.confirmation_number) !== target.pmsConfirmationNumber ||
		clean(reservation?.reservation_id) !== target.otaBookingId ||
		upper(reservation?.hr_number) !== target.hrNumber ||
		lower(reservation?.otaIdentityKey) !== identity ||
		clean(reservation?.otaCrossTransportIdentityKey) ||
		lower(reservation?.state) !== "ota platform review" ||
		lower(reservation?.reservation_status) !== "ota platform review" ||
		dateKey(reservation?.checkin_date) !== target.checkinDate ||
		dateKey(reservation?.checkout_date) !== target.checkoutDate ||
		Number(reservation?.total_rooms) !== 1 ||
		upper(reservation?.currency) !== "SAR" ||
		round2(reservation?.sub_total) !== target.rootTotalSar ||
		round2(reservation?.adminPricing?.rootTotal) !== target.rootTotalSar ||
		round2(reservation?.ota_financial_summary?.hotelVisibleAmount) !==
			target.rootTotalSar ||
		Number(reservation?.commission || 0) !== 0 ||
		lower(reservation?.supplierData?.hotelRunner?.transport) !== "hotelrunner_api" ||
		clean(reservation?.supplierData?.hotelRunner?.reservationId) !==
			target.hotelRunnerReservationId ||
		rooms.length !== 1 ||
		rooms[0].hotelRoomConfigId !== target.roomConfigId ||
		rooms[0].localRoomConfigId !== target.roomConfigId ||
		rooms[0].sourceRoomName !== target.sourceRoomName ||
		hashObject(reservation?.pickedRoomsType || []) !==
			hashObject(reservation?.pickedRoomsPricing || [])
	) {
		fail(`${target.key} PMS ownership, lifecycle, stay, room, or root boundary changed.`);
	}
}

function normalizedFromAudit(target, audit) {
	const normalized = extractNormalizedReservation({
		from: audit.from,
		to: audit.to,
		subject: audit.subject,
		text: audit.bodyText,
		html: audit.bodyHtml,
		messageId: audit.messageId,
		senderAuthentication: audit.senderAuthentication,
		sourceReceivedAt:
			audit?.normalizedReservation?.source?.receivedAt || audit.receivedAt,
		deliveryReceivedAt: audit.receivedAt,
		date: audit?.normalizedReservation?.source?.messageDate || null,
		sourceTimestampMethod:
			audit?.normalizedReservation?.source?.timestampMethod || "stored_inbound_audit",
	});
	const stableConversionAt =
		audit?.normalizedReservation?.paymentSummary?.amountConvertedAt ||
		audit?.normalizedReservation?.amountConvertedAt ||
		audit?.normalizedReservation?.source?.receivedAt ||
		audit.receivedAt;
	return {
		...normalized,
		inboundEmailId: target.inboundEmailId,
		amountConvertedAt: stableConversionAt,
		paymentSummary: {
			...(normalized.paymentSummary || {}),
			amountConvertedAt: stableConversionAt,
		},
	};
}

function assertParsedEvidence(target, normalized, evidence) {
	if (
		normalized.provider !== "agoda" ||
		normalized.sourceSenderAuthenticated !== true ||
		normalized.requiresManualReview === true ||
		clean(normalized.confirmationNumber) !== target.otaBookingId ||
		dateKey(normalized.checkinDate) !== target.checkinDate ||
		dateKey(normalized.checkoutDate) !== target.checkoutDate ||
		clean(normalized.roomName) !== target.parsedRoomName ||
		Number(normalized.roomCount) !== 1 ||
		round2(normalized.totalAmountSar) !== target.grossTotalSar ||
		round2(normalized.totalPayoutSar) !== target.payoutTotalSar ||
		round2(normalized.otaCommissionSar) !== target.otaCommissionSar
	) {
		fail(`${target.key} stored Agoda body no longer parses to the exact audited facts.`);
	}
	if (
		!evidence ||
		evidence.version !== 2 ||
		evidence.verified !== true ||
		evidence.inboundEmailId !== target.inboundEmailId ||
		round2(evidence.grossTotalSar) !== target.grossTotalSar ||
		round2(evidence.payoutTotalSar) !== target.payoutTotalSar ||
		round2(evidence.otaExpenseTotalSar) !== target.otaExpenseTotalSar ||
		round2(evidence.otaCommissionSar) !== target.otaCommissionSar ||
		round2(evidence.unclassifiedDeductionSar) !==
			target.unclassifiedDeductionSar ||
		hashObject(evidence.deductionComponents.map((item) => item.amountSar)) !==
			hashObject(target.componentAmounts) ||
		hashObject(evidence.unpricedDeductionLabels) !==
			hashObject(["Targeted promotions"])
	) {
		fail(`${target.key} authenticated commercial evidence changed.`);
	}
}

function dailyCommercialRows(rooms = []) {
	return (Array.isArray(rooms) ? rooms : []).flatMap((room) =>
		(Array.isArray(room?.pricingByDay) ? room.pricingByDay : []).map((day) => ({
			client: round2(day?.clientPrice),
			root: round2(day?.rootPrice),
			payout: round2(day?.netAfterExpenses),
			expense: round2(day?.otaExpenseAmount),
			margin: round2(day?.platformMargin),
			source: round2(day?.hotelRunnerSourcePrice),
		}))
	);
}

function assertPlannedCommercialSet(target, reservation, set, evidence) {
	const rows = dailyCommercialRows(set.pickedRoomsPricing);
	if (
		round2(set.total_amount) !== target.grossTotalSar ||
		round2(set.commission) !== 0 ||
		round2(set.commission_ota) !== target.otaCommissionSar ||
		round2(set["adminPricing.clientTotal"]) !== target.grossTotalSar ||
		round2(set["adminPricing.netAfterExpensesTotal"]) !== target.payoutTotalSar ||
		round2(set["adminPricing.otaExpenseTotal"]) !== target.otaExpenseTotalSar ||
		round2(set["ota_financial_summary.clientTotal"]) !== target.grossTotalSar ||
		round2(set["ota_financial_summary.otaCommissionAmount"]) !==
			target.otaCommissionSar ||
		clean(set["supplierData.hotelRunnerEmailCommercialEvidence"]?.evidenceHash) !==
			clean(evidence.evidenceHash) ||
		hashObject(rows.map((row) => row.client)) !== hashObject(target.dailyClient) ||
		hashObject(rows.map((row) => row.root)) !== hashObject(target.dailyRoot) ||
		hashObject(rows.map((row) => row.payout)) !== hashObject(target.dailyPayout) ||
		hashObject(rows.map((row) => row.expense)) !== hashObject(target.dailyExpense) ||
		hashObject(rows.map((row) => row.margin)) !== hashObject(target.dailyMargin) ||
		hashObject(rows.map((row) => row.source)) !== hashObject(target.dailyPayout)
	) {
		fail(`${target.key} planned daily or aggregate commercial result is not exact.`);
	}
	const projected = applyDottedSet(reservation, set);
	if (
		hashObject(protectedReservationSnapshot(projected)) !==
		hashObject(protectedReservationSnapshot(reservation))
	) {
		fail(`${target.key} planned set changes protected lifecycle, guest, stay, room, root, or payment data.`);
	}
}

function isApplied(scope, releaseSha) {
	const marker = verifiedHotelRunnerEmailCommercialEvidence(scope.reservation, {
		provider: "agoda",
		grossTotalSar: scope.target.grossTotalSar,
		currency: "SAR",
	});
	const audit = (Array.isArray(scope.reservation?.reservationAuditLog)
		? scope.reservation.reservationAuditLog
		: []
	).find(
		(entry) =>
			clean(entry?.repairId) === REPAIR_ID &&
			lower(entry?.releaseSha) === lower(releaseSha) &&
			clean(entry?.inboundEmailId) === scope.target.inboundEmailId
	);
	return marker && audit ? { marker, audit } : null;
}

async function loadTargetScope(
	target,
	hotel,
	{ evidenceAppliedAt, releaseSha, session = null, models = {} } = {}
) {
	const ReservationModel = models.ReservationModel || Reservations;
	const EventModel = models.EventModel || HotelRunnerEvent;
	const MirrorModel = models.MirrorModel || HotelRunnerReservation;
	const InboundModel = models.InboundModel || InboundEmail;
	const reservations = await leanMany(ReservationModel, reservationLookup(target), {
		session,
		limit: 3,
	});
	if (!Array.isArray(reservations) || reservations.length !== 1) {
		fail(`${target.key} requires exactly one matching PMS reservation; found ${reservations?.length || 0}.`);
	}
	// MongoDB does not support parallel operations on one transaction session.
	// Keep the immutable envelope reads serial so apply has one deterministic path.
	const event = await leanOne(
		EventModel,
		{ _id: target.eventId },
		{ session, select: "+payload" }
	);
	const mirror = await leanOne(
		MirrorModel,
		{ _id: target.mirrorId },
		{ session }
	);
	const audit = await leanOne(
		InboundModel,
		{ _id: target.inboundEmailId },
		{ session }
	);
	const reservation = reservations[0];
	assertReservationBoundary(target, reservation);
	assertEnvelope(target, event, mirror, audit);
	const baseScope = { target, reservation, event, mirror, audit, hotel };
	const applied = isApplied(baseScope, releaseSha);
	if (applied) {
		return {
			...baseScope,
			state: "already_applied",
			evidence: applied.marker,
			set: null,
			protectedHash: hashObject(protectedReservationSnapshot(reservation)),
		};
	}
	if (
		Number(reservation.__v || 0) !== target.reservationVersion ||
		round2(reservation.total_amount) !== target.payoutTotalSar ||
		reservation.commission_ota !== null ||
		reservation.adminPricing?.commercialVerified === true ||
		reservation.ota_financial_summary?.commercialVerified === true
	) {
		fail(`${target.key} no longer has the exact audited pre-repair commercial state.`);
	}
	const normalized = normalizedFromAudit(target, audit);
	const evidence = buildHotelRunnerEmailCommercialEvidence(normalized, {
		appliedAt: evidenceAppliedAt,
	});
	assertParsedEvidence(target, normalized, evidence);
	const guard = directHotelRunnerEmailCommercialGuard({
		normalized,
		existing: reservation,
		hotelDetails: hotel,
		matchedReservationBy: ["otaIdentityKey"],
		evidence,
	});
	if (guard.ok !== true || guard.reportedTotalRole !== "payout") {
		fail(`${target.key} shared commercial guard rejected: ${clean(guard.reason) || "unknown"}.`);
	}
	const set = directHotelRunnerCommercialEnrichmentSet(normalized, evidence, {
		reportedTotalRole: guard.reportedTotalRole,
		existing: reservation,
		commercialPricing: guard.commercialPricing,
	});
	if (!set) fail(`${target.key} could not build a bounded commercial update set.`);
	assertPlannedCommercialSet(target, reservation, set, evidence);
	return {
		...baseScope,
		normalized,
		evidence,
		set,
		state: "ready",
		protectedHash: hashObject(protectedReservationSnapshot(reservation)),
	};
}

function immutableScopeEntry(scope) {
	return {
		key: scope.target.key,
		state: scope.state,
		reservationMongoId: scope.target.reservationMongoId,
		reservationVersion: Number(scope.reservation.__v || 0),
		reservationProtectedHash: scope.protectedHash,
		reservationCommercialBeforeHash: hashObject({
			total_amount: scope.reservation.total_amount,
			commission: scope.reservation.commission,
			commission_ota: scope.reservation.commission_ota,
			pickedRoomsPricing: scope.reservation.pickedRoomsPricing,
			adminPricing: scope.reservation.adminPricing,
			ota_financial_summary: scope.reservation.ota_financial_summary,
		}),
		eventId: scope.target.eventId,
		eventPayloadHash: scope.target.eventPayloadHash,
		canonicalHash: scope.target.canonicalHash,
		mirrorId: scope.target.mirrorId,
		inboundEmailId: scope.target.inboundEmailId,
		bodyTextHash: scope.target.bodyTextHash,
		evidenceHash: clean(scope.evidence?.evidenceHash),
		plannedSetHash: scope.set ? hashObject(scope.set) : "",
	};
}

async function loadPlan({
	evidenceAppliedAt,
	releaseSha,
	applyStrategy = TRANSACTION_APPLY_STRATEGY,
	session = null,
	models = {},
	targets = EXACT_TARGETS,
} = {}) {
	if (!APPLY_STRATEGIES.has(applyStrategy)) {
		fail("The database apply strategy is not supported.", "AGODA_REPAIR_STRATEGY_INVALID");
	}
	const HotelModel = models.HotelModel || HotelDetails;
	const hotel = await leanOne(
		HotelModel,
		{ _id: EXPECTED_HOTEL_ID },
		{ session }
	);
	assertHotel(hotel);
	const scopes = [];
	for (const target of targets) {
		scopes.push(
			await loadTargetScope(target, hotel, {
				evidenceAppliedAt,
				releaseSha,
				session,
				models,
			})
		);
	}
	const states = new Set(scopes.map((scope) => scope.state));
	if (states.size !== 1 || !["ready", "already_applied"].includes([...states][0])) {
		fail("The two exact reservations are not in one consistent repair state.");
	}
	const immutableScope = scopes.map(immutableScopeEntry);
	const proofBasis = {
		version: 1,
		repairId: REPAIR_ID,
		releaseSha: lower(releaseSha),
		applyStrategy,
		evidenceAppliedAt: new Date(evidenceAppliedAt).toISOString(),
		hotelId: EXPECTED_HOTEL_ID,
		immutableScope,
	};
	return {
		repairId: REPAIR_ID,
		releaseSha: lower(releaseSha),
		applyStrategy,
		evidenceAppliedAt: new Date(evidenceAppliedAt),
		state: [...states][0],
		scopes,
		immutableScope,
		planHash: hashObject(proofBasis),
	};
}

function proofToken(plan) {
	return `${plan.evidenceAppliedAt.getTime()}.${plan.planHash}`;
}

function reservationCasFilter(scope) {
	return {
		_id: scope.target.reservationMongoId,
		__v: scope.target.reservationVersion,
		hotelId: EXPECTED_HOTEL_ID,
		confirmation_number: scope.target.pmsConfirmationNumber,
		reservation_id: scope.target.otaBookingId,
		otaIdentityKey: `agoda:${scope.target.otaBookingId}`,
		otaCrossTransportIdentityKey: "",
		state: scope.reservation.state,
		reservation_status: scope.reservation.reservation_status,
		checkin_date: scope.reservation.checkin_date,
		checkout_date: scope.reservation.checkout_date,
		total_rooms: 1,
		total_amount: scope.target.payoutTotalSar,
		sub_total: scope.target.rootTotalSar,
		commission: 0,
		commission_ota: null,
		pickedRoomsType: scope.reservation.pickedRoomsType,
		pickedRoomsPricing: scope.reservation.pickedRoomsPricing,
		updatedAt: scope.reservation.updatedAt,
		"supplierData.hotelRunner.transport": "hotelrunner_api",
		"supplierData.hotelRunner.reservationId":
			scope.target.hotelRunnerReservationId,
		"adminPricing.clientTotal": scope.target.payoutTotalSar,
		"adminPricing.rootTotal": scope.target.rootTotalSar,
		"adminPricing.commercialVerified": false,
		"ota_financial_summary.clientTotal": scope.target.payoutTotalSar,
		"ota_financial_summary.hotelVisibleAmount": scope.target.rootTotalSar,
		"ota_financial_summary.commercialVerified": false,
		"supplierData.hotelRunnerEmailCommercialEvidence": null,
	};
}

function repairAuditEntry(scope, plan) {
	return {
		at: plan.evidenceAppliedAt,
		source: "authenticated-agoda-email-repair",
		action: "hotelrunner-commercial-enriched-from-verified-email",
		provider: "agoda",
		eventType: "new",
		reservationId: scope.target.otaBookingId,
		messageId: scope.audit.messageId || "",
		subject: scope.audit.subject || "",
		warnings: [],
		repairId: REPAIR_ID,
		releaseSha: plan.releaseSha,
		applyStrategy: plan.applyStrategy,
		inboundEmailId: scope.target.inboundEmailId,
		evidenceHash: scope.evidence.evidenceHash,
		vendorApiCalls: 0,
	};
}

async function applyPlanInTransaction(
	plan,
	{
		startSession = () => mongoose.startSession(),
		models = {},
		targets = EXACT_TARGETS,
	} = {}
) {
	if (plan.state === "already_applied") {
		return { state: "already_applied", changed: 0, vendorApiCalls: 0 };
	}
	const ReservationModel = models.ReservationModel || Reservations;
	const session = await startSession();
	if (!session || typeof session.withTransaction !== "function") {
		fail("MongoDB transaction support is required for the two-record repair.");
	}
	let changed = 0;
	try {
		await session.withTransaction(
			async () => {
				let attemptChanged = 0;
				const livePlan = await loadPlan({
					evidenceAppliedAt: plan.evidenceAppliedAt,
					releaseSha: plan.releaseSha,
					applyStrategy: plan.applyStrategy,
					session,
					models,
					targets,
				});
				if (
					livePlan.state !== "ready" ||
					livePlan.planHash !== plan.planHash
				) {
					fail("Live transaction state no longer matches the dry-run proof.", "AGODA_REPAIR_PROOF_MISMATCH");
				}
				for (const scope of livePlan.scopes) {
					const result = await ReservationModel.updateOne(
						reservationCasFilter(scope),
						{
							$set: scope.set,
							$push: { reservationAuditLog: repairAuditEntry(scope, livePlan) },
							$inc: { __v: 1 },
						},
						{ session }
					);
					const matched = Number(result?.matchedCount ?? result?.n ?? 0);
					const modified = Number(result?.modifiedCount ?? result?.nModified ?? 0);
					if (matched !== 1 || modified !== 1) {
						fail(`${scope.target.key} CAS write did not modify exactly one reservation.`);
					}
					attemptChanged += 1;
				}
				changed = attemptChanged;
			},
			{
				readConcern: { level: "snapshot" },
				writeConcern: { w: "majority" },
				readPreference: "primary",
			}
		);
	} finally {
		if (typeof session.endSession === "function") await session.endSession();
	}
	if (changed !== targets.length) {
		fail("The transaction did not repair every exact reservation.");
	}
	const verified = await loadPlan({
		evidenceAppliedAt: plan.evidenceAppliedAt,
		releaseSha: plan.releaseSha,
		applyStrategy: plan.applyStrategy,
		models,
		targets,
	});
	if (verified.state !== "already_applied") {
		fail("Post-commit verification did not prove both exact repairs.");
	}
	for (const scope of verified.scopes) {
		const before = plan.scopes.find((item) => item.target.key === scope.target.key);
		if (scope.protectedHash !== before.protectedHash) {
			fail(`${scope.target.key} protected post-commit hash changed.`);
		}
	}
	return { state: "applied", changed, verified, vendorApiCalls: 0 };
}

function standaloneDocumentPlan(scope, plan) {
	const update = {
		$set: {
			...scope.set,
			updatedAt: plan.evidenceAppliedAt,
		},
		$push: { reservationAuditLog: repairAuditEntry(scope, plan) },
		$inc: { __v: 1 },
	};
	const originalDocument = cloneBson(scope.reservation);
	const expectedDocument = applyUpdateToDocument(originalDocument, update);
	assertReservationBoundary(scope.target, expectedDocument);
	if (!isApplied({ ...scope, reservation: expectedDocument }, plan.releaseSha)) {
		fail(`${scope.target.key} standalone expected document is not an exact applied repair.`);
	}
	if (
		hashObject(protectedReservationSnapshot(expectedDocument)) !==
		hashObject(protectedReservationSnapshot(originalDocument))
	) {
		fail(`${scope.target.key} standalone replacement changes protected data.`);
	}
	return {
		target: scope.target,
		originalDocument,
		expectedDocument,
		originalHash: canonicalEjsonSha256(originalDocument),
		expectedHash: canonicalEjsonSha256(expectedDocument),
		casFilter: buildExactCasFilter(originalDocument),
	};
}

function standaloneReservationCollection(models, ReservationModel) {
	const collection = models.ReservationCollection || ReservationModel?.collection;
	if (
		!collection ||
		typeof collection.findOne !== "function" ||
		typeof collection.replaceOne !== "function"
	) {
		fail("The raw reservation collection is required for full-document standalone CAS.");
	}
	return collection;
}

async function readStandaloneReservation(collection, documentPlan) {
	return collection.findOne(
		{ _id: cloneBson(documentPlan.originalDocument._id) },
		{
			readPreference: "primary",
			readConcern: { level: "majority" },
		}
	);
}

async function replaceWithHashReadback({
	collection,
	documentPlan,
	beforeDocument,
	afterDocument,
	beforeHash,
	afterHash,
}) {
	let acknowledgementError = null;
	try {
		const result = await collection.replaceOne(
			buildExactCasFilter(beforeDocument),
			cloneBson(afterDocument),
			{ writeConcern: { w: "majority" } }
		);
		const matched = Number(result?.matchedCount ?? result?.n ?? 0);
		const modified = Number(result?.modifiedCount ?? result?.nModified ?? 0);
		if (result?.acknowledged === false || matched !== 1 || modified !== 1) {
			throw new Error(`${documentPlan.target.key} full-document CAS did not replace exactly one reservation.`);
		}
	} catch (error) {
		acknowledgementError = error;
	}
	// One primary/majority read resolves a lost acknowledgement. There is no
	// reservation write retry anywhere in the standalone path.
	const observed = await readStandaloneReservation(collection, documentPlan);
	const observedHash = observed ? canonicalEjsonSha256(observed) : "";
	if (observedHash === afterHash) {
		return {
			document: observed,
			acknowledgementLost: Boolean(acknowledgementError),
		};
	}
	if (observedHash === beforeHash) {
		const error = new Error(
			`${documentPlan.target.key} standalone CAS did not commit${
				acknowledgementError ? `: ${acknowledgementError.message}` : "."
			}`
		);
		error.writeResolution = "before";
		throw error;
	}
	const error = new Error(
		`${documentPlan.target.key} standalone CAS is ambiguous; the live document is neither exact before nor exact after.`
	);
	error.writeResolution = "changed_or_missing";
	error.observedHash = observedHash;
	throw error;
}

async function classifyStandaloneDocuments(collection, documentPlans) {
	const classifications = [];
	for (const documentPlan of documentPlans) {
		const observed = await readStandaloneReservation(collection, documentPlan);
		const observedHash = observed ? canonicalEjsonSha256(observed) : "";
		classifications.push({
			documentPlan,
			state:
				observedHash === documentPlan.originalHash
					? "original"
					: observedHash === documentPlan.expectedHash
					? "repaired"
					: "changed_or_missing",
		});
	}
	return classifications;
}

async function compensateStandaloneApply({ collection, documentPlans, cause }) {
	const initial = await classifyStandaloneDocuments(collection, documentPlans);
	for (const classification of [...initial].reverse()) {
		if (classification.state !== "repaired") continue;
		const documentPlan = classification.documentPlan;
		await replaceWithHashReadback({
			collection,
			documentPlan,
			beforeDocument: documentPlan.expectedDocument,
			afterDocument: documentPlan.originalDocument,
			beforeHash: documentPlan.expectedHash,
			afterHash: documentPlan.originalHash,
		});
	}
	const final = await classifyStandaloneDocuments(collection, documentPlans);
	if (final.some((entry) => entry.state === "changed_or_missing")) {
		fail(
			`Standalone compensation preserved a concurrent third state and stopped: ${cause.message}`,
			"AGODA_REPAIR_MANUAL_INTERVENTION_REQUIRED"
		);
	}
	if (!final.every((entry) => entry.state === "original")) {
		fail(
			`Standalone compensation could not restore both exact originals: ${cause.message}`,
			"AGODA_REPAIR_COMPENSATION_FAILED"
		);
	}
	const error = new Error(
		`Standalone apply failed and both exact originals were verified restored: ${cause.message}`
	);
	error.code = "AGODA_REPAIR_COMPENSATED";
	throw error;
}

async function applyPlanStandalone(
	plan,
	{ models = {}, targets = EXACT_TARGETS } = {}
) {
	if (plan.state === "already_applied") {
		return { state: "already_applied", changed: 0, vendorApiCalls: 0 };
	}
	const ReservationModel = models.ReservationModel || Reservations;
	const collection = standaloneReservationCollection(models, ReservationModel);
	const documentPlans = plan.scopes.map((scope) =>
		standaloneDocumentPlan(scope, plan)
	);
	let acknowledgementsRecovered = 0;
	try {
		for (const documentPlan of documentPlans) {
			const resolution = await replaceWithHashReadback({
				collection,
				documentPlan,
				beforeDocument: documentPlan.originalDocument,
				afterDocument: documentPlan.expectedDocument,
				beforeHash: documentPlan.originalHash,
				afterHash: documentPlan.expectedHash,
			});
			if (resolution.acknowledgementLost) acknowledgementsRecovered += 1;
		}
	} catch (error) {
		return compensateStandaloneApply({
			collection,
			documentPlans,
			cause: error,
		});
	}
	const verified = await loadPlan({
		evidenceAppliedAt: plan.evidenceAppliedAt,
		releaseSha: plan.releaseSha,
		applyStrategy: plan.applyStrategy,
		models,
		targets,
	});
	if (verified.state !== "already_applied") {
		fail("Standalone post-write verification did not prove both exact repairs.");
	}
	for (const scope of verified.scopes) {
		const before = plan.scopes.find((item) => item.target.key === scope.target.key);
		if (scope.protectedHash !== before.protectedHash) {
			fail(`${scope.target.key} standalone protected post-write hash changed.`);
		}
	}
	return {
		state: "applied",
		changed: documentPlans.length,
		verified,
		acknowledgementsRecovered,
		vendorApiCalls: 0,
	};
}

async function applyPlan(plan, options = {}) {
	if (plan.applyStrategy === TRANSACTION_APPLY_STRATEGY) {
		return applyPlanInTransaction(plan, options);
	}
	if (plan.applyStrategy === STANDALONE_APPLY_STRATEGY) {
		return applyPlanStandalone(plan, options);
	}
	fail("The planned database apply strategy is unsupported.");
}

function targetSummary(scope) {
	const rows = dailyCommercialRows(scope.reservation.pickedRoomsPricing);
	const marker = scope.evidence;
	return {
		requestedIdentifier: scope.target.requestedIdentifier,
		pmsConfirmationNumber: scope.target.pmsConfirmationNumber,
		agodaBookingId: scope.target.otaBookingId,
		reservationMongoId: scope.target.reservationMongoId,
		state: scope.state,
		reservationCount: 1,
		hotelRunnerOwner: true,
		grossTotalSar:
			scope.state === "ready"
				? scope.target.grossTotalSar
				: round2(scope.reservation.total_amount),
		rootTotalSar: scope.target.rootTotalSar,
		payoutTotalSar:
			scope.state === "ready"
				? scope.target.payoutTotalSar
				: round2(scope.reservation.adminPricing?.netAfterExpensesTotal),
		otaExpenseTotalSar:
			scope.state === "ready"
				? scope.target.otaExpenseTotalSar
				: round2(scope.reservation.adminPricing?.otaExpenseTotal),
		commission: 0,
		commissionOta:
			scope.state === "ready"
				? scope.target.otaCommissionSar
				: round2(scope.reservation.commission_ota),
		dailyPricing:
			scope.state === "ready"
				? {
						client: scope.target.dailyClient,
						root: scope.target.dailyRoot,
						payout: scope.target.dailyPayout,
						expense: scope.target.dailyExpense,
						margin: scope.target.dailyMargin,
				  }
				: rows,
		commercialVerified: marker?.verified === true,
		evidenceHash: clean(marker?.evidenceHash),
		inboundEmailId: scope.target.inboundEmailId,
		duplicate: false,
	};
}

function sanitizedOutput(plan, mode, proof = "") {
	return {
		mode,
		repairId: REPAIR_ID,
		releaseSha: plan.releaseSha,
		applyStrategy: plan.applyStrategy,
		proof: mode === "dry_run" && plan.state === "ready" ? proof : undefined,
		proofExpiresInMinutes:
			mode === "dry_run" && plan.state === "ready"
				? PROOF_MAX_AGE_MS / 60_000
				: undefined,
		targetCount: plan.scopes.length,
		state: plan.state,
		targets: plan.scopes.map(targetSummary),
		createsReservations: false,
		mutatesLifecycleGuestStayRoomAssignmentOrPayment: false,
		mutatesHotelRunnerEventMirrorOrInboundAudit: false,
		standaloneSafety:
			plan.applyStrategy === STANDALONE_APPLY_STRATEGY
				? {
						writes: "serialized full-document BSON-aware CAS with majority acknowledgement",
						lostAcknowledgement: "one primary/majority hash readback and no write retry",
						failure: "reverse exact-CAS compensation of every completed repair write",
				  }
				: undefined,
		vendorApiCalls: 0,
	};
}

async function connectDatabase(database) {
	await mongoose.connect(database, {
		useNewUrlParser: true,
		useUnifiedTopology: true,
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
		resolveReleaseSha = currentReleaseSha,
		resolveDatabaseApplyStrategy = resolveApplyStrategy,
		models = {},
		startSession,
	} = {}
) {
	const options = parseArguments(argv);
	assertRelease(options.releaseSha, resolveReleaseSha());
	const now = clock();
	const proofDetails = options.apply ? parseProof(options.proof, now) : null;
	const evidenceAppliedAt = proofDetails?.plannedAt || now;
	const database =
		process.env.DATABASE || process.env.MONGO_URI || process.env.MONGODB_URI;
	if (!database && !models.skipConnect) fail("Missing DATABASE/MONGO connection string.");
	let connectedHere = false;
	try {
		if (!models.skipConnect) {
			await connect(database);
			connectedHere = true;
		}
		const applyStrategy =
			models.applyStrategy || (await resolveDatabaseApplyStrategy());
		const plan = await loadPlan({
			evidenceAppliedAt,
			releaseSha: options.releaseSha,
			applyStrategy,
			models,
		});
		const generatedProof = proofToken(plan);
		if (
			options.apply &&
			(proofDetails.planHash !== plan.planHash || options.proof !== generatedProof)
		) {
			fail("The live exact scope does not match the supplied dry-run proof.", "AGODA_REPAIR_PROOF_MISMATCH");
		}
		console.log(
			JSON.stringify(
				sanitizedOutput(plan, options.apply ? "apply" : "dry_run", generatedProof),
				null,
				2
			)
		);
		if (!options.apply) return { state: "dry_run_ready", plan, proof: generatedProof };
		const result = await applyPlan(plan, { models, startSession });
		console.log(
			JSON.stringify(
				{
					state: result.state,
					repairId: REPAIR_ID,
					releaseSha: plan.releaseSha,
					applyStrategy: plan.applyStrategy,
					changed: result.changed,
					acknowledgementsRecovered:
						Number(result.acknowledgementsRecovered || 0),
					targetCount: EXACT_TARGETS.length,
					vendorApiCalls: 0,
				},
				null,
				2
			)
		);
		return result;
	} finally {
		if (connectedHere) await disconnect();
	}
}

if (require.main === module) {
	main().catch((error) => {
		console.error("[agoda-commercial-enrichment-repair] stopped", {
			code: clean(error?.code || "AGODA_COMMERCIAL_REPAIR_FAILED").slice(0, 100),
			message: clean(error?.message || "Unknown repair failure").slice(0, 500),
		});
		process.exitCode = 1;
	});
}

module.exports = {
	EXACT_TARGETS,
	EXPECTED_HOTEL_ID,
	PROOF_MAX_AGE_MS,
	REPAIR_ID,
	STANDALONE_APPLY_STRATEGY,
	TRANSACTION_APPLY_STRATEGY,
	applyDottedSet,
	applyPlan,
	applyPlanInTransaction,
	applyPlanStandalone,
	assertEnvelope,
	assertParsedEvidence,
	assertPlannedCommercialSet,
	assertRelease,
	currentReleaseSha,
	dailyCommercialRows,
	immutableScopeEntry,
	loadPlan,
	loadTargetScope,
	main,
	normalizedFromAudit,
	parseArguments,
	parseProof,
	proofToken,
	protectedReservationSnapshot,
	repairAuditEntry,
	reservationCasFilter,
	reservationLookup,
	resolveApplyStrategy,
	sanitizedOutput,
	sha256,
	standaloneDocumentPlan,
};
