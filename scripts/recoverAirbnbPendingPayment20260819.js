/** @format */

"use strict";

// Closed-scope, proof-gated recovery for one authenticated Airbnb confirmation
// whose commercial amount was explicitly still processing. The manifest has no
// guest PII. Dry-run is the default; apply reuses the ordinary OTA reconciler.

require("dotenv").config();

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const mongoose = require("mongoose");

mongoose.set("strictQuery", true);

const HotelDetails = require("../models/hotel_details");
const InboundEmail = require("../models/inbound_email");
const Reservations = require("../models/reservations");
const {
	applyExactResolvedHotelToUnmappedReview,
	buildOtaConfirmationLookup,
	buildOtaIdentityKey,
	buildUnmappedOtaReviewReservationDocument,
	canCreateUnmappedOtaReviewReservation,
	extractNormalizedReservation,
	hashText,
	reconcileOtaReservation,
	requiredNewReservationMissing,
	resolveHotel,
} = require("../services/otaReservationMapper");
const {
	CLOCK_SKEW_MS,
	HOTELRUNNER_DISABLED_GATES,
	PROOF_MAX_AGE_MS,
	RECOVERY_RESERVATION_EVIDENCE_SELECT,
	RecoverySafetyError,
	assertDormantHotelRunnerState,
	assertHotelRunnerDisabled,
	assertNoForbiddenHotelRunnerRuntimeModules,
	assertRequiredIndexes,
	broadConfirmationLookup,
	canonicalize,
	emailFromAudit,
	guestKeyHash,
	hashObject,
	loadDormantHotelRunnerState,
	laterAuditLookup,
	parseArgumentsForRepair,
	parseProof,
	terminalLifecycle,
	withOutboundHttpBlocked,
} = require("./recoverMissedDirectOtaReservations20260813");

const REPAIR_ID = "airbnb-pending-payment-recovery-20260819-v1";
const POLICY_DATE = "2026-08-19";
const NPM_SCRIPT = "ota:recover-airbnb-pending-payment-20260819";
const HOTEL_ID = "6a40b6a1a6efe70450536038";
const OWNER_ID = "68b74714fb50e159d48c714d";

const TARGET = Object.freeze({
	repairId: REPAIR_ID,
	policyDate: POLICY_DATE,
	provider: "airbnb",
	confirmationNumber: "hmkpa39adt",
	auditId: "6a85df6ad528708d33e9288c",
	emailHash: "08679a5a3b0f2c5762d50c92d9b7c3f254acf21d2555c48ceb6289747031377f",
	textHash: "ecb7e8f90ff73f24138baac15d0960836f3e83d91e74d275b04edead080bdfff",
	messageIdHash: "e4a1db65374c9b1d1aec5e61e75f3b5f58dfb49dfb2e54bdb404d60a06ffa2da",
	dedupeKeyHash: "efb9034f60b0197de856b1f392db5e0c63a4ef3c7c1a79251059784e3641f0ff",
	subjectHash: "bf132c68c0ca0d0588eae3994d4d86549b46cf39ca0f05346771662d4de23965",
	bodyHtmlHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
	storedNormalizedHash: "54434c7023362fe345c8e0fb4a249e6588a2c2c64c5b51aa82e3212a635d95bf",
	guestKeyHash: "22edfbc2c82925c70484353e999af3126906ec4d2f3fc6cec27e5255953dc66e",
	from: '"Airbnb" <automated@airbnb.com>',
	sourceReceivedAt: "2026-08-19T16:52:54.000Z",
	receivedAt: "2026-08-19T16:52:58.347Z",
	createdAt: "2026-08-19T16:52:58.362Z",
	updatedAt: "2026-08-19T16:53:13.000Z",
	version: 0,
	hotelId: HOTEL_ID,
	ownerId: OWNER_ID,
	listingId: "1742269093942004753",
	listingTitle: "COMFY QUAD FAMILY ROOM - AJYAD - FREE BUS TO HARAM",
	checkinDate: "2026-08-19",
	checkoutDate: "2026-08-21",
	roomCount: 1,
	adults: 2,
	children: 2,
	totalGuests: 4,
});

const clean = (value) => String(value ?? "").trim();
const lower = (value) => clean(value).toLowerCase();
const id = (value) => lower(value?._id || value);
const sha256 = (value) =>
	crypto.createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
const dateIso = (value) => {
	if (value === null || value === undefined || value === "") return "";
	const parsed = value instanceof Date ? value : new Date(value);
	return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : "";
};
const dateOnly = (value) => dateIso(value).slice(0, 10);

function fail(code, message, details = {}) {
	throw new RecoverySafetyError(code, message, details);
}

function parseArguments(argv = process.argv.slice(2)) {
	return parseArgumentsForRepair(argv, REPAIR_ID);
}

function assertCommonArchive(audit) {
	assert.ok(audit, `Missing inbound archive ${TARGET.auditId}.`);
	assert.equal(id(audit._id), TARGET.auditId, "Archive ID changed.");
	assert.equal(lower(audit.source), "sendgrid", "Archive source changed.");
	assert.equal(lower(audit.provider), TARGET.provider, "Archive provider changed.");
	assert.equal(lower(audit.confirmationNumber), TARGET.confirmationNumber, "Archive confirmation changed.");
	assert.equal(audit.emailHash, TARGET.emailHash, "Archive email hash changed.");
	assert.equal(audit.textHash, TARGET.textHash, "Archive text hash changed.");
	assert.equal(hashText(audit.bodyText || ""), TARGET.textHash, "Archived body no longer matches its hash.");
	assert.equal(sha256(audit.bodyHtml || ""), TARGET.bodyHtmlHash, "Archived HTML representation changed.");
	assert.equal(sha256(audit.messageId || ""), TARGET.messageIdHash, "Message-ID hash changed.");
	assert.equal(sha256(audit.dedupeKey || ""), TARGET.dedupeKeyHash, "Dedupe-key hash changed.");
	assert.equal(sha256(audit.subject || ""), TARGET.subjectHash, "Subject hash changed.");
	assert.equal(clean(audit.from), TARGET.from, "Authenticated sender changed.");
	assert.equal(dateIso(audit.receivedAt), TARGET.receivedAt, "Delivery timestamp changed.");
	assert.equal(dateIso(audit.createdAt), TARGET.createdAt, "Archive creation timestamp changed.");
	assert.equal(Number(audit.__v), TARGET.version, "Archive version changed.");
	assert.equal(Boolean(audit.duplicateOf), false, "Archive became a duplicate.");
	assert.equal(audit.senderAuthentication?.authenticatedAligned, true, "Aligned authentication was lost.");
	assert.equal(audit.senderAuthentication?.dkimAlignedPass, true, "Aligned DKIM proof was lost.");
	assert.equal(lower(audit.senderAuthentication?.trustedProvider), TARGET.provider, "Trusted provider changed.");
	return true;
}

function assertOriginalArchive(audit) {
	assertCommonArchive(audit);
	assert.equal(dateIso(audit.updatedAt), TARGET.updatedAt, "Original archive update timestamp changed.");
	assert.equal(lower(audit.processingStatus), "needs_review", "Archive is no longer in the original review state.");
	assert.equal(lower(audit.automationAction), "skipped", "Original automation action changed.");
	assert.equal(lower(audit.skipReason), "ota_manual_review_no_reservation_created", "Original skip reason changed.");
	assert.equal(lower(audit.reconciliation?.skipReason), "ota_manual_review_no_reservation_created", "Original reconciliation reason changed.");
	assert.equal(id(audit.reservationMongoId), "", "Archive is already linked.");
	assert.equal(id(audit.hotelId), "", "Original archive acquired a hotel link.");
	assert.equal(audit.hasReservationConnection, false, "Original archive acquired a reservation connection.");
	assert.equal(lower(audit.reconciliation?.repairId), "", "Archive already has a repair marker.");
	assert.equal(hashObject(audit.normalizedReservation || {}), TARGET.storedNormalizedHash, "Stored normalized snapshot changed.");
	return true;
}

function assertAppliedArchive(audit, reservation) {
	assertCommonArchive(audit);
	assert.equal(lower(audit.processingStatus), "created");
	assert.equal(lower(audit.automationAction), "created");
	assert.equal(clean(audit.skipReason), "");
	assert.equal(audit.hasReservationConnection, true);
	assert.equal(id(audit.reservationMongoId), id(reservation._id));
	assert.equal(id(audit.hotelId), TARGET.hotelId);
	assert.equal(lower(audit.reconciliation?.repairId), REPAIR_ID);
	assert.equal(audit.reconciliation?.policyDate, POLICY_DATE);
	assert.equal(audit.reconciliation?.ordinaryOtaReconciler, true);
	assert.equal(audit.reconciliation?.commercialAmountsInvented, false);
	assert.equal(audit.reconciliation?.paymentProcessingPending, true);
	assert.equal(audit.sourceAmount, null);
	assert.equal(audit.totalAmountSar, null);
	assert.equal(lower(audit.paymentCollectionModel), "unknown");
	const normalized = audit.normalizedReservation || {};
	assert.equal(lower(normalized.provider), TARGET.provider);
	assert.equal(lower(normalized.confirmationNumber), TARGET.confirmationNumber);
	assert.equal(normalized.airbnbPaymentProcessingPending, true);
	assert.equal(normalized.sourcePresence?.airbnbPaymentProcessingPending, true);
	assert.equal(normalized.airbnbListingId, TARGET.listingId);
	assert.equal(normalized.airbnbListingTitle, TARGET.listingTitle);
	assert.equal(normalized.checkinDate, TARGET.checkinDate);
	assert.equal(normalized.checkoutDate, TARGET.checkoutDate);
	assert.equal(Number(normalized.totalGuests), TARGET.totalGuests);
	assert.equal(id(normalized.inboundEmailId), TARGET.auditId);
	return true;
}

function sourceBody(audit) {
	return String(emailFromAudit(audit).text || "");
}

function assertPendingPaymentSourceBoundary(audit) {
	const body = sourceBody(audit);
	if (!/(?:^|\n)\s*Allow\s+time\s+for\s+payment\s+processing\.?(?:\s+Learn\s+more)?\s*(?:\n|$)/i.test(body)) {
		fail("RECOVERY_PENDING_PAYMENT_EVIDENCE_CHANGED", "The exact Airbnb payment-processing-pending line is missing.");
	}
	if (/\b(?:SAR|USD|EUR|GBP|AED)\b/i.test(body)) {
		fail("RECOVERY_COMMERCIAL_EVIDENCE_APPEARED", "The archived Airbnb source now contains a currency token; automatic unpriced recovery stopped.");
	}
	if (/(?:^|\n)\s*(?:Guest\s+total|Total\s*(?:\([^)]+\))?|You\s+earn)\s*(?::|\n)/i.test(body)) {
		fail("RECOVERY_COMMERCIAL_EVIDENCE_APPEARED", "The archived Airbnb source now contains a commercial amount label; automatic unpriced recovery stopped.");
	}
	return true;
}

function mergePinnedListingIdentity(fresh, stored) {
	assert.equal(lower(stored.provider), TARGET.provider, "Stored provider changed.");
	assert.equal(lower(stored.confirmationNumber), TARGET.confirmationNumber, "Stored confirmation changed.");
	assert.equal(stored.airbnbListingId, TARGET.listingId, "Stored listing ID changed.");
	assert.equal(stored.airbnbListingTitle, TARGET.listingTitle, "Stored listing title changed.");
	assert.equal(id(stored.hotelId), TARGET.hotelId, "Stored hotel mapping changed.");
	assert.equal(stored.airbnbMapping?.matchStrength, "exact_alias", "Stored mapping strength changed.");
	assert.equal(stored.airbnbMapping?.matchedValue, TARGET.listingTitle, "Stored mapping value changed.");
	return {
		...fresh,
		inboundEmailId: TARGET.auditId,
		airbnbListingId: TARGET.listingId,
		airbnbListingTitle: TARGET.listingTitle,
		hotelId: TARGET.hotelId,
		hotelIdMatchStrength: stored.hotelIdMatchStrength,
		hotelIdMatchedValue: stored.hotelIdMatchedValue,
		airbnbMapping: canonicalize(stored.airbnbMapping),
		sourcePresence: {
			...(fresh.sourcePresence || {}),
			airbnbListingId: true,
			airbnbPaymentProcessingPending: true,
		},
	};
}

function assertNormalizedBoundary(normalized) {
	assert.equal(lower(normalized.provider), TARGET.provider);
	assert.equal(lower(normalized.confirmationNumber || normalized.reservationId), TARGET.confirmationNumber);
	assert.equal(lower(normalized.intent), "new_reservation");
	assert.equal(lower(normalized.eventType), "new");
	assert.equal(normalized.sourceSenderAuthenticated, true);
	assert.equal(normalized.sourceSenderTrusted, true);
	assert.equal(normalized.requiresManualReview, false);
	assert.equal(normalized.blocksUnmappedReservationCreation, false);
	assert.equal(normalized.ambiguousMultiRoomEvidence === true, false);
	assert.equal(normalized.airbnbPaymentProcessingPending, true);
	assert.equal(normalized.sourcePresence?.airbnbPaymentProcessingPending, true);
	assert.equal(normalized.sourcePresence?.amount, false);
	assert.equal(normalized.airbnbListingId, TARGET.listingId);
	assert.equal(normalized.airbnbListingTitle, TARGET.listingTitle);
	assert.equal(id(normalized.hotelId), TARGET.hotelId);
	assert.equal(normalized.checkinDate, TARGET.checkinDate);
	assert.equal(normalized.checkoutDate, TARGET.checkoutDate);
	assert.equal(Number(normalized.roomCount || 1), TARGET.roomCount);
	assert.equal(Number(normalized.adults), TARGET.adults);
	assert.equal(Number(normalized.children), TARGET.children);
	assert.equal(Number(normalized.totalGuests), TARGET.totalGuests);
	assert.equal(guestKeyHash(normalized.guestName), TARGET.guestKeyHash);
	assert.equal(normalized.totalPayoutSar, null);
	assert.equal(normalized.sourcePayoutAmount, null);
	assert.deepEqual(requiredNewReservationMissing(normalized), ["positive source-backed guest total"]);
	assert.equal(canCreateUnmappedOtaReviewReservation(normalized, true), true);
	return true;
}

function freshNormalizedFromArchive(audit) {
	assertPendingPaymentSourceBoundary(audit);
	const fresh = extractNormalizedReservation(emailFromAudit(audit));
	assert.equal(fresh.airbnbPaymentProcessingPending, true, "Deployed parser does not recognize Airbnb's pending-payment state.");
	const merged = mergePinnedListingIdentity(fresh, audit.normalizedReservation || {});
	assertNormalizedBoundary(merged);
	return merged;
}

function noPhysicalRoomAssignments(document) {
	assert.deepEqual((document.roomId || []).map(id), []);
	assert.deepEqual((document.bedNumber || []).map(id), []);
	for (const room of [
		...(document.pickedRoomsType || []),
		...(document.pickedRoomsPricing || []),
	]) {
		assert.equal(id(room.hotelRoomConfigId), "");
		assert.deepEqual((room.chosenRoomNumbers || []).map(id), []);
		assert.deepEqual((room.chosenBedNumbers || []).map(id), []);
	}
	return true;
}

function markerMatches(reservation) {
	const marker = reservation.supplierData?.directOtaArchiveRecovery || {};
	return (
		lower(marker.repairId) === REPAIR_ID &&
		marker.policyDate === POLICY_DATE &&
		id(marker.inboundEmailId) === TARGET.auditId &&
		lower(marker.provider) === TARGET.provider &&
		lower(marker.confirmationNumber) === TARGET.confirmationNumber &&
		marker.emailHash === TARGET.emailHash &&
		marker.textHash === TARGET.textHash &&
		marker.commercialAmountsInvented === false &&
		marker.paymentProcessingPending === true
	);
}

function assertExpectedReservationShape(document, { persisted = false } = {}) {
	assert.equal(id(document.hotelId), TARGET.hotelId);
	assert.equal(id(document.belongsTo), TARGET.ownerId);
	assert.equal(lower(document.reservation_id), TARGET.confirmationNumber);
	assert.equal(lower(document.customer_details?.confirmation_number2), TARGET.confirmationNumber);
	assert.equal(buildOtaIdentityKey(TARGET.provider, TARGET.confirmationNumber), `airbnb:${TARGET.confirmationNumber}`);
	if (persisted) assert.equal(lower(document.otaIdentityKey), `airbnb:${TARGET.confirmationNumber}`);
	assert.equal(clean(document.state), "OTA Platform Review");
	assert.equal(clean(document.reservation_status), "OTA Platform Review");
	assert.equal(dateOnly(document.checkin_date), TARGET.checkinDate);
	assert.equal(dateOnly(document.checkout_date), TARGET.checkoutDate);
	assert.equal(Number(document.total_rooms), TARGET.roomCount);
	assert.equal(Number(document.total_guests), TARGET.totalGuests);
	assert.equal(Number(document.adults), TARGET.adults);
	assert.equal(Number(document.children), TARGET.children);
	assert.equal(guestKeyHash(document.customer_details?.name), TARGET.guestKeyHash);
	assert.equal(document.total_amount, null);
	assert.equal(Number(document.sub_total), 0);
	assert.equal(Number(document.paid_amount), 0);
	assert.equal(lower(document.payment), "not paid");
	assert.equal(lower(document.financeStatus), "not paid");
	assert.equal(Number(document.commission), 0);
	assert.equal(document.commission_ota, null);
	assert.equal(document.adminPricing?.clientTotal, null);
	assert.equal(Number(document.adminPricing?.rootTotal), 0);
	assert.equal(document.adminPricing?.netAfterExpensesTotal, null);
	assert.equal(document.adminPricing?.otaExpenseTotal, null);
	assert.equal(document.adminPricing?.platformMarginTotal, null);
	assert.equal(document.adminPricing?.commercialResolution, "unresolved");
	assert.equal(document.adminPricing?.sourceAmount, null);
	assert.equal(document.ota_financial_summary?.clientTotal, null);
	assert.equal(document.ota_financial_summary?.netAfterExpenses, null);
	assert.equal(document.ota_financial_summary?.otaExpenseTotal, null);
	assert.equal(document.ota_financial_summary?.platformProfit, null);
	assert.equal(document.supplierData?.otaAmount, null);
	assert.equal(document.supplierData?.otaAmountSar, null);
	assert.equal(document.supplierData?.otaSourceAmount, null);
	assert.equal(document.supplierData?.otaTotalPayoutSar, null);
	assert.equal(document.supplierData?.otaExpenseTotalSar, null);
	assert.equal(document.supplierData?.otaPlatformMarginSar, null);
	assert.equal(document.supplierData?.otaAirbnbListingId, TARGET.listingId);
	assert.equal(document.supplierData?.otaAirbnbListingTitle, TARGET.listingTitle);
	assert.equal(clean(document.otaPlatformReview?.status), "pending");
	assert.equal(document.otaPlatformReview?.hotelAssignmentRequired, false);
	assert.equal(document.otaPlatformReview?.roomMappingStatus, "unreviewed");
	assert.equal((document.pickedRoomsPricing || []).length, 1);
	assert.deepEqual(
		document.pickedRoomsPricing[0].pricingByDay.map((day) => ({
			date: dateOnly(day.date),
			clientPrice: day.clientPrice,
			rootPrice: Number(day.rootPrice),
			netAfterExpenses: day.netAfterExpenses,
			platformMargin: day.platformMargin,
		})),
		[
			{ date: "2026-08-19", clientPrice: null, rootPrice: 0, netAfterExpenses: null, platformMargin: null },
			{ date: "2026-08-20", clientPrice: null, rootPrice: 0, netAfterExpenses: null, platformMargin: null },
		]
	);
	noPhysicalRoomAssignments(document);
	if (persisted) {
		assert.equal(document.supplierData?.otaAirbnbPaymentProcessingPending, true);
		assert.equal(markerMatches(document), true, "Persisted reservation lacks exact recovery provenance.");
		assert.ok(clean(document.confirmation_number), "PMS confirmation is missing.");
		assert.notEqual(lower(document.confirmation_number), TARGET.confirmationNumber, "PMS and Airbnb confirmations must remain distinct.");
	}
	return true;
}

function stampRecoveryProvenance(document, plannedAt) {
	document.supplierData = {
		...(document.supplierData || {}),
		directOtaArchiveRecovery: {
			repairId: REPAIR_ID,
			policyDate: POLICY_DATE,
			inboundEmailId: TARGET.auditId,
			provider: TARGET.provider,
			confirmationNumber: TARGET.confirmationNumber,
			emailHash: TARGET.emailHash,
			textHash: TARGET.textHash,
			appliedAt: new Date(plannedAt),
			ordinaryOtaReconciler: true,
			orderTakerNormalizationUsed: false,
			commercialAmountsInvented: false,
			paymentProcessingPending: true,
		},
	};
	const log = Array.isArray(document.reservationAuditLog) ? document.reservationAuditLog : [];
	if (!log.some((entry) => lower(entry?.repairId) === REPAIR_ID && id(entry?.inboundEmailId) === TARGET.auditId)) {
		document.reservationAuditLog = [
			...log,
			{
				at: new Date(plannedAt),
				action: "recovered-authenticated-airbnb-pending-payment",
				repairId: REPAIR_ID,
				inboundEmailId: TARGET.auditId,
				provider: TARGET.provider,
				confirmationNumber: TARGET.confirmationNumber,
				note: "Proof-gated recovery through the ordinary OTA reconciler; commercial amounts remain unknown and the stay remains in OTA Platform Review.",
			},
		];
	}
	return document;
}

function dayBounds(ymd) {
	const start = new Date(`${ymd}T00:00:00.000Z`);
	return { $gte: start, $lt: new Date(start.getTime() + 86400000) };
}

function uniqueReservations(reservations = []) {
	return Array.from(new Map(reservations.map((item) => [id(item._id), item])).values());
}

async function loadReservationEvidence(dependencies = {}) {
	const Model = dependencies.Reservations || Reservations;
	const select = `${RECOVERY_RESERVATION_EVIDENCE_SELECT} adults children`;
	const [providerMatches, broadMatches, stayMatches] = await Promise.all([
		Model.find(buildOtaConfirmationLookup(TARGET.confirmationNumber, TARGET.provider)).select(select).lean().exec(),
		Model.find(broadConfirmationLookup(TARGET)).select(select).lean().exec(),
		Model.find({
			hotelId: TARGET.hotelId,
			checkin_date: dayBounds(TARGET.checkinDate),
			checkout_date: dayBounds(TARGET.checkoutDate),
		}).select(select).lean().exec(),
	]);
	const exact = uniqueReservations([...providerMatches, ...broadMatches]);
	const exactIds = new Set(exact.map((item) => id(item._id)));
	const plausible = uniqueReservations(stayMatches)
		.filter((item) => !exactIds.has(id(item._id)))
		.filter((item) => guestKeyHash(item.customer_details?.name) === TARGET.guestKeyHash)
		.map((item) => ({ reservationId: id(item._id), reasons: ["same_hotel", "same_stay", "same_normalized_primary_guest"] }));
	const recovered = exact.filter(markerMatches);
	return {
		exact,
		plausible,
		recovered,
		safeSummary: {
			exactReservationIds: exact.map((item) => id(item._id)).sort(),
			plausible,
			recoveredReservationIds: recovered.map((item) => id(item._id)).sort(),
		},
	};
}

async function loadLaterAuditEvidence(dependencies = {}) {
	const Model = dependencies.InboundEmail || InboundEmail;
	const audits = await Model.find(laterAuditLookup(TARGET))
		.sort({ receivedAt: 1, _id: 1 })
		.lean()
		.exec();
	const terminal = [];
	const fingerprints = [];
	for (const audit of audits) {
		let fresh = {};
		try {
			fresh = extractNormalizedReservation(emailFromAudit(audit));
		} catch (_error) {
			fresh = {};
		}
		if (terminalLifecycle(audit.normalizedReservation || {}) || terminalLifecycle(fresh)) {
			terminal.push(id(audit._id));
		}
		fingerprints.push({
			auditId: id(audit._id),
			provider: lower(audit.provider),
			intent: lower(audit.intent),
			eventType: lower(audit.eventType),
			processingStatus: lower(audit.processingStatus),
			receivedAt: dateIso(audit.receivedAt),
			emailHash: lower(audit.emailHash),
			textHash: lower(audit.textHash),
			reservationMongoId: id(audit.reservationMongoId),
		});
	}
	return { terminal, fingerprints };
}

async function resolveExpectedDocument(normalized, dependencies = {}) {
	const HotelModel = dependencies.HotelDetails || HotelDetails;
	const hotel = await HotelModel.findById(TARGET.hotelId).lean().exec();
	assert.ok(hotel, "Exact hotel is missing.");
	assert.equal(id(hotel._id), TARGET.hotelId);
	assert.equal(id(hotel.belongsTo), TARGET.ownerId);
	assert.equal(hotel.activateHotel, true, "Exact hotel is inactive.");
	assert.notEqual(hotel.xHotelProActive, false, "Exact hotel is not PMS-active.");
	const resolved = await (dependencies.resolveHotel || resolveHotel)(normalized, null);
	assert.equal(id(resolved?._id), TARGET.hotelId, "Fresh exact hotel resolution changed.");
	const document = buildUnmappedOtaReviewReservationDocument(normalized);
	assert.equal(applyExactResolvedHotelToUnmappedReview(document, hotel, normalized), true, "Exact hotel could not be safely assigned.");
	assertExpectedReservationShape(document);
	return { hotel, document };
}

async function loadScope(dependencies = {}) {
	const AuditModel = dependencies.InboundEmail || InboundEmail;
	const audit = await AuditModel.findById(TARGET.auditId).lean().exec();
	assertCommonArchive(audit);
	const applied = lower(audit.reconciliation?.repairId) === REPAIR_ID;
	if (!applied) assertOriginalArchive(audit);
	const normalized = freshNormalizedFromArchive(audit);
	const resolved = await resolveExpectedDocument(normalized, dependencies);
	const [evidence, laterAudits, dormantHotelRunnerState] = await Promise.all([
		loadReservationEvidence(dependencies),
		loadLaterAuditEvidence(dependencies),
		loadDormantHotelRunnerState(TARGET, dependencies.db || mongoose.connection.db),
	]);
	if (laterAudits.terminal.length) {
		fail("RECOVERY_LATER_TERMINAL_EVENT", "A later authenticated terminal lifecycle archive exists; recovery stopped.", { auditId: TARGET.auditId, laterTerminalAuditIds: laterAudits.terminal });
	}
	assertDormantHotelRunnerState(TARGET, dormantHotelRunnerState);
	if (evidence.plausible.length) {
		fail("RECOVERY_PLAUSIBLE_MANUAL_DUPLICATE", "A plausible same-guest reservation exists; recovery stopped.", { auditId: TARGET.auditId, candidates: evidence.plausible });
	}
	let action = "create_unpriced_ota_review";
	if (applied) {
		assert.equal(evidence.exact.length, 1, "Applied recovery no longer has one exact reservation.");
		assert.equal(evidence.recovered.length, 1, "Applied recovery provenance is missing.");
		assertAppliedArchive(audit, evidence.recovered[0]);
		assertExpectedReservationShape(evidence.recovered[0], { persisted: true });
		action = "already_applied_noop";
	} else if (evidence.exact.length === 1 && evidence.recovered.length === 1) {
		assertExpectedReservationShape(evidence.recovered[0], { persisted: true });
		action = "finalize_lost_ack_only";
	} else if (evidence.exact.length) {
		fail("RECOVERY_RESERVATION_IDENTITY_PRESENT", "A reservation already owns this Airbnb identity without exact recovery provenance; recovery stopped.", evidence.safeSummary);
	}
	return { audit, normalized, resolved, evidence, laterAudits, dormantHotelRunnerState, action };
}

function scopeBasis(scope) {
	return {
		audit: {
			auditId: TARGET.auditId,
			emailHash: TARGET.emailHash,
			textHash: TARGET.textHash,
			status: lower(scope.audit.processingStatus),
			skipReason: lower(scope.audit.skipReason),
			reservationId: id(scope.audit.reservationMongoId),
			repairId: lower(scope.audit.reconciliation?.repairId),
			updatedAt: dateIso(scope.audit.updatedAt),
		},
		normalized: {
			identity: `${TARGET.provider}:${TARGET.confirmationNumber}`,
			listingId: TARGET.listingId,
			listingTitleHash: sha256(TARGET.listingTitle),
			stay: [scope.normalized.checkinDate, scope.normalized.checkoutDate],
			occupancy: [scope.normalized.adults, scope.normalized.children, scope.normalized.totalGuests],
			guestKeyHash: guestKeyHash(scope.normalized.guestName),
			paymentProcessingPending: scope.normalized.airbnbPaymentProcessingPending === true,
			amountSourcePresent: scope.normalized.sourcePresence?.amount === true,
		},
		mapping: { hotelId: id(scope.resolved.hotel._id), ownerId: id(scope.resolved.hotel.belongsTo), roomConfigurationAssigned: false },
		commercial: { guestTotal: null, payout: null, expense: null, root: 0, platformMargin: null },
		reservations: scope.evidence.safeSummary,
		laterAudits: scope.laterAudits.fingerprints,
		dormantHotelRunnerState: scope.dormantHotelRunnerState,
		action: scope.action,
	};
}

async function buildPlan(plannedAt = new Date(), dependencies = {}) {
	assertHotelRunnerDisabled(dependencies.env || process.env);
	assertNoForbiddenHotelRunnerRuntimeModules();
	const ReservationModel = dependencies.Reservations || Reservations;
	const AuditModel = dependencies.InboundEmail || InboundEmail;
	const [reservationIndexes, inboundIndexes] = await Promise.all([
		ReservationModel.collection.indexes(),
		AuditModel.collection.indexes(),
	]);
	assertRequiredIndexes(reservationIndexes, inboundIndexes);
	const scope = await loadScope(dependencies);
	const basis = {
		policyDate: POLICY_DATE,
		repairId: REPAIR_ID,
		plannedAt: dateIso(plannedAt),
		target: scopeBasis(scope),
		indexProof: {
			reservation: reservationIndexes.find((item) => item.name === "uniq_ota_identity_key"),
			crossTransportReservation: reservationIndexes.find((item) => item.name === "uniq_ota_cross_transport_identity_key"),
			inbound: inboundIndexes.find((item) => item.name === "uniq_inbound_email_dedupe_key"),
		},
		hotelRunnerGates: Object.fromEntries(HOTELRUNNER_DISABLED_GATES.map((key) => [key, lower((dependencies.env || process.env)[key])])),
	};
	return { plannedAt: new Date(plannedAt), planHash: hashObject(basis), basis, scope };
}

function proofToken(plan) {
	return `${new Date(plan.plannedAt).getTime()}.${plan.planHash}`;
}

async function lastMomentGuard(scope, plan, dependencies = {}) {
	return async ({ reservationData, mapped }) => {
		assert.equal(mapped, false, "Pending-payment recovery must remain an unmapped OTA review.");
		assertExpectedReservationShape(reservationData);
		assert.equal(reservationData.supplierData?.otaAirbnbPaymentProcessingPending, true);
		assertHotelRunnerDisabled(dependencies.env || process.env);
		assertNoForbiddenHotelRunnerRuntimeModules();
		const AuditModel = dependencies.InboundEmail || InboundEmail;
		const ReservationModel = dependencies.Reservations || Reservations;
		const audit = await AuditModel.findById(TARGET.auditId).lean().exec();
		assertOriginalArchive(audit);
		const [evidence, laterAudits, dormant, reservationIndexes, inboundIndexes] = await Promise.all([
			loadReservationEvidence(dependencies),
			loadLaterAuditEvidence(dependencies),
			loadDormantHotelRunnerState(TARGET, dependencies.db || mongoose.connection.db),
			ReservationModel.collection.indexes(),
			AuditModel.collection.indexes(),
		]);
		assertRequiredIndexes(reservationIndexes, inboundIndexes);
		assert.deepEqual(reservationIndexes.find((item) => item.name === "uniq_ota_identity_key"), plan.basis.indexProof.reservation);
		assert.deepEqual(reservationIndexes.find((item) => item.name === "uniq_ota_cross_transport_identity_key"), plan.basis.indexProof.crossTransportReservation);
		assert.deepEqual(inboundIndexes.find((item) => item.name === "uniq_inbound_email_dedupe_key"), plan.basis.indexProof.inbound);
		assert.equal(evidence.exact.length, 0, "An exact reservation appeared before insert.");
		assert.equal(evidence.plausible.length, 0, "A plausible same-guest reservation appeared before insert.");
		assert.deepEqual(laterAudits, scope.laterAudits, "Later archive evidence changed after dry-run.");
		assertDormantHotelRunnerState(TARGET, dormant);
		stampRecoveryProvenance(reservationData, plan.plannedAt);
	};
}

function auditRecoveryUpdate(scope, reconciliation, reservation) {
	return {
		processingStatus: "created",
		automationAction: "created",
		skipReason: "",
		automationComment: "Authenticated Airbnb confirmation preserved in OTA Platform Review while payment processing is pending; no commercial amount or PMS room assignment was invented.",
		hasReservationConnection: true,
		matchedReservationBy: ["otaIdentityKey"],
		reservationMongoId: reservation._id,
		hotelId: TARGET.hotelId,
		pmsConfirmationNumber: reservation.confirmation_number,
		hotelName: scope.normalized.hotelName || "",
		roomName: scope.normalized.roomName || "",
		sourceAmount: null,
		sourceCurrency: "",
		totalAmountSar: null,
		exchangeRateToSar: 0,
		exchangeRateSource: "",
		paymentCollectionModel: "unknown",
		normalizedReservation: scope.normalized,
		orchestratorDecision: {
			usedAI: false,
			skipped: true,
			skipReason: "authenticated_airbnb_pending_payment_recovery",
			repairId: REPAIR_ID,
			policyDate: POLICY_DATE,
		},
		reconciliation: {
			status: reconciliation?.status || "lost_ack_recovered",
			actionTaken: "created",
			repairId: REPAIR_ID,
			policyDate: POLICY_DATE,
			provider: TARGET.provider,
			confirmationNumber: TARGET.confirmationNumber,
			reservationId: reservation._id,
			hotelId: TARGET.hotelId,
			pmsConfirmationNumber: reservation.confirmation_number,
			recoveredFromInboundAudit: true,
			ordinaryOtaReconciler: true,
			orderTakerNormalizationUsed: false,
			commercialAmountsInvented: false,
			paymentProcessingPending: true,
			directArchiveEvidence: { inboundEmailId: TARGET.auditId, emailHash: TARGET.emailHash, textHash: TARGET.textHash },
		},
		processedAt: new Date(),
	};
}

async function finalizeAudit(scope, reconciliation, reservation, dependencies = {}) {
	const Model = dependencies.InboundEmail || InboundEmail;
	const result = await Model.updateOne(
		{
			_id: TARGET.auditId,
			__v: TARGET.version,
			source: "sendgrid",
			provider: TARGET.provider,
			confirmationNumber: TARGET.confirmationNumber,
			messageId: scope.audit.messageId,
			emailHash: TARGET.emailHash,
			textHash: TARGET.textHash,
			dedupeKey: scope.audit.dedupeKey,
			receivedAt: new Date(TARGET.receivedAt),
			updatedAt: new Date(TARGET.updatedAt),
			duplicateOf: null,
			processingStatus: "needs_review",
			automationAction: "skipped",
			skipReason: "ota_manual_review_no_reservation_created",
			reservationMongoId: null,
			"senderAuthentication.authenticatedAligned": true,
			"senderAuthentication.dkimAlignedPass": true,
			"senderAuthentication.trustedProvider": TARGET.provider,
		},
		{ $set: auditRecoveryUpdate(scope, reconciliation, reservation) },
		{ writeConcern: { w: "majority" } }
	);
	if (result.matchedCount !== 1 || result.modifiedCount !== 1) {
		const observed = await Model.findById(TARGET.auditId).lean().exec();
		if (lower(observed?.reconciliation?.repairId) !== REPAIR_ID || id(observed?.reservationMongoId) !== id(reservation._id)) {
			fail("RECOVERY_AUDIT_CAS_LOST", "The authoritative Airbnb audit changed before finalization.", { auditId: TARGET.auditId });
		}
	}
	const finalAudit = await Model.findById(TARGET.auditId).lean().exec();
	assertAppliedArchive(finalAudit, reservation);
	return finalAudit;
}

async function applyPlan(plan, dependencies = {}) {
	const scope = plan.scope;
	if (scope.action === "already_applied_noop") {
		return { action: scope.action, reservationId: id(scope.evidence.recovered[0]._id) };
	}
	let reconciliation = null;
	let reservation = scope.action === "finalize_lost_ack_only" ? scope.evidence.recovered[0] : null;
	if (!reservation) {
		const beforeCreateInsert = await lastMomentGuard(scope, plan, dependencies);
		let reconcileError = null;
		try {
			reconciliation = await withOutboundHttpBlocked(() =>
				(dependencies.reconcileOtaReservation || reconcileOtaReservation)(scope.normalized, { beforeCreateInsert })
			);
		} catch (error) {
			reconcileError = error;
		}
		const evidence = await loadReservationEvidence(dependencies);
		if (evidence.exact.length === 1 && evidence.recovered.length === 1 && evidence.plausible.length === 0) {
			reservation = evidence.recovered[0];
		} else if (reconcileError) {
			throw reconcileError;
		} else {
			fail("RECOVERY_RECONCILE_RESULT_INVALID", "Ordinary OTA reconciliation did not leave one provenance-linked review reservation.", { status: reconciliation?.status || "", evidence: evidence.safeSummary });
		}
	}
	assertExpectedReservationShape(reservation, { persisted: true });
	await finalizeAudit(scope, reconciliation, reservation, dependencies);
	const post = await loadReservationEvidence(dependencies);
	assert.equal(post.exact.length, 1, "Post-recovery identity is not unique.");
	assert.equal(post.recovered.length, 1, "Post-recovery provenance is not unique.");
	assert.equal(post.plausible.length, 0, "A plausible duplicate appeared after recovery.");
	const dormant = await loadDormantHotelRunnerState(TARGET, dependencies.db || mongoose.connection.db);
	assertDormantHotelRunnerState(TARGET, dormant);
	return { action: scope.action, reservationId: id(reservation._id), otaPlatformReview: lower(reservation.otaPlatformReview?.status), commercialAmountsInvented: false };
}

function safeOutput(plan, mode) {
	return {
		mode,
		policyDate: POLICY_DATE,
		repairId: REPAIR_ID,
		plannedAt: dateIso(plan.plannedAt),
		planHash: plan.planHash,
		target: {
			identity: `${TARGET.provider}:${TARGET.confirmationNumber}`,
			auditId: TARGET.auditId,
			hotelId: TARGET.hotelId,
			listingId: TARGET.listingId,
			stay: [TARGET.checkinDate, TARGET.checkoutDate],
			occupancy: { adults: TARGET.adults, children: TARGET.children, total: TARGET.totalGuests },
			commercialAmounts: "unknown",
			roomAssignment: "unassigned",
			action: plan.scope.action,
		},
	};
}

async function run(options = parseArguments(), dependencies = {}) {
	if (options.apply && clean(options.repairId) !== REPAIR_ID) {
		fail("RECOVERY_REPAIR_ID_REQUIRED", `--apply requires --repair-id=${REPAIR_ID}.`);
	}
	assertHotelRunnerDisabled(dependencies.env || process.env);
	assertNoForbiddenHotelRunnerRuntimeModules();
	const database = dependencies.database || process.env.DATABASE || process.env.MONGO_URI || process.env.MONGODB_URI;
	assert.ok(database || dependencies.skipConnect, "Missing DATABASE/MONGO connection string.");
	if (!dependencies.skipConnect) await mongoose.connect(database, { autoIndex: false });
	const proof = options.apply ? parseProof(options.proof, dependencies.now?.() || new Date()) : null;
	const plan = await buildPlan(proof?.plannedAt || dependencies.now?.() || new Date(), dependencies);
	if (options.apply && (proof.planHash !== plan.planHash || proofToken(plan) !== options.proof)) {
		fail("RECOVERY_PLAN_CHANGED", "The live recovery plan no longer matches the dry-run proof.");
	}
	const output = safeOutput(plan, options.apply ? "apply" : "dry-run");
	if (!options.apply) {
		output.proof = proofToken(plan);
		output.proofExpiresInMinutes = PROOF_MAX_AGE_MS / 60000;
		output.applyCommand = `npm run ${NPM_SCRIPT} -- --apply --repair-id=${REPAIR_ID} --proof=${output.proof}`;
		console.log(JSON.stringify(output, null, 2));
		return output;
	}
	const result = await applyPlan(plan, dependencies);
	const final = { ...output, success: true, result, hotelRunnerApiCalls: 0, outboundHttpAllowed: false };
	console.log(JSON.stringify(final, null, 2));
	return final;
}

if (require.main === module) {
	run()
		.catch((error) => {
			console.error(JSON.stringify({ success: false, code: error.code || "RECOVERY_FAILED", message: clean(error.message) }, null, 2));
			process.exitCode = 1;
		})
		.finally(async () => {
			if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
		});
}

module.exports = {
	CLOCK_SKEW_MS,
	NPM_SCRIPT,
	POLICY_DATE,
	REPAIR_ID,
	TARGET,
	applyPlan,
	assertAppliedArchive,
	assertCommonArchive,
	assertExpectedReservationShape,
	assertNormalizedBoundary,
	assertOriginalArchive,
	assertPendingPaymentSourceBoundary,
	buildPlan,
	freshNormalizedFromArchive,
	markerMatches,
	parseArguments,
	proofToken,
	run,
	stampRecoveryProvenance,
};
