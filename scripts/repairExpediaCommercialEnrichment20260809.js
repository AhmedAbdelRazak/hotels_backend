/** @format */

"use strict";

/**
 * Exact, fail-closed production repair for Expedia 2530158461 / PMS 7255791395.
 *
 * Dry run:
 *   node scripts/repairExpediaCommercialEnrichment20260809.js \
 *     --release-sha=<exact-merged-sha> \
 *     [--portal-job-id=<exact-job-id> --portal-job-number=<exact-job-number>]
 *
 * Apply the exact dry-run proof:
 *   node scripts/repairExpediaCommercialEnrichment20260809.js --apply \
 *     --repair-id=expedia-commercial-enrichment-20260809-v1 \
 *     --release-sha=<exact-merged-sha> --proof=<dry-run-proof> \
 *     [--portal-job-id=<same-job-id> --portal-job-number=<same-job-number>]
 *
 * Rollback dry run / apply:
 *   node scripts/repairExpediaCommercialEnrichment20260809.js --rollback \
 *     --repair-id=expedia-commercial-enrichment-20260809-v1 \
 *     --release-sha=<exact-running-sha> \
 *     [--portal-job-id=<same-job-id> --portal-job-number=<same-job-number>]
 *   node scripts/repairExpediaCommercialEnrichment20260809.js --rollback --apply \
 *     --repair-id=expedia-commercial-enrichment-20260809-v1 \
 *     --release-sha=<exact-running-sha> --proof=<rollback-dry-run-proof> \
 *     [--portal-job-id=<same-job-id> --portal-job-number=<same-job-number>]
 *
 * This module imports no provider client or collector and makes zero vendor calls.
 * Exactly one reservation is mutable. HotelRunner event/mirror and the supervised
 * Expedia preview job are immutable evidence and are fully backed up with strict
 * canonical EJSON before the reservation's one full-document CAS replacement.
 */

const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const { EJSON, ObjectId } = require("bson");
const mongoose = require("mongoose");

require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);

const HotelRunnerEvent = require("../models/hotelrunner_event");
const HotelRunnerReservation = require("../models/hotelrunner_reservation");
const OtaReservationSyncJob = require("../models/ota_reservation_sync_job");
const Reservations = require("../models/reservations");
const {
	buildExactCasFilter,
	canonicalEjsonSha256,
	cloneBson,
} = require("../services/recentOtaInboundRecovery20260805");
const {
	buildAuthenticatedProviderCommercialEvidence,
	validateOtaCommercialEvidence,
} = require("../services/otaCommercialEvidence");

const REPAIR_ID = "expedia-commercial-enrichment-20260809-v1";
const PROOF_MAX_AGE_MS = 30 * 60 * 1000;
const MANIFEST_COLLECTION = "ota_expedia_commercial_repair_manifests";
const BACKUP_COLLECTION = "ota_expedia_commercial_repair_backup_20260809_v1";

const COLLECTIONS = Object.freeze({
	reservation: Reservations.collection.collectionName,
	event: HotelRunnerEvent.collection.collectionName,
	mirror: HotelRunnerReservation.collection.collectionName,
	portalJob: OtaReservationSyncJob.collection.collectionName,
});

const TARGET = Object.freeze({
	hotelId: "6a40b6a1a6efe70450536038",
	reservationMongoId: "6a77efde7735a50431e27126",
	reservationVersion: 1,
	pmsConfirmationNumber: "7255791395",
	otaBookingId: "2530158461",
	otaIdentityKey: "expedia:2530158461",
	checkinDate: "2026-10-05",
	checkoutDate: "2026-10-11",
	nights: 6,
	hotelRunnerReservationId: "40371346",
	hrNumber: "R166595975",
	eventId: "6a77efd0d8cbed2f4bad4722",
	eventPayloadHash:
		"4783f5ad70a7df6c6c432d7179b044a4045d6c555d31d7d13bada059b9fef01d",
	eventCanonicalHash:
		"550c4a710ba0d157a4c95987aa545c96a3c2c97001b4d9e4c2e57505f018f5ea",
	eventStatus: "completed",
	mirrorId: "6a77efd166c058f4ab61706f",
	portalJobId: "6a77f627cdbc8acbbe4968a5",
	portalJobNumber: "OTA-RES-SYNC-20260809033815-N7DTC",
	portalDateFrom: "2026-10-04",
	portalDateTo: "2026-10-12",
	propertyCurrency: "SAR",
	sourceCurrency: "USD",
	portalGuestGross: 146.46,
	hotelRunnerReportedAmount: 112.92,
	oldCanonicalClientTotal: 423.45,
	rootTotal: 534,
	dailyRoot: Object.freeze([89, 89, 89, 89, 89, 89]),
	dailyFalseCanonical: Object.freeze([70.58, 70.58, 70.58, 70.57, 70.57, 70.57]),
	dailyHotelRunnerSource: Object.freeze([18.82, 18.82, 18.82, 18.82, 18.82, 18.82]),
});

const DEFAULT_PORTAL_SELECTION = Object.freeze({
	jobId: TARGET.portalJobId,
	jobNumber: TARGET.portalJobNumber,
});

const COMMERCIAL_DAY_FIELDS = Object.freeze([
	"price",
	"clientPrice",
	"mainPrice",
	"totalPriceWithCommission",
	"netAfterExpenses",
	"netAfterOtaExpenses",
	"otaExpenseAmount",
	"platformMargin",
]);
const COMMERCIAL_ROOM_FIELDS = Object.freeze([
	"chosenPrice",
	"totalPriceWithCommission",
]);
const ADMIN_COMMERCIAL_FIELDS = Object.freeze([
	"clientTotal",
	"netAfterExpensesTotal",
	"otaExpenseTotal",
	"platformMarginTotal",
	"commissionAmount",
	"commercialVerified",
	"commercialVerificationState",
	"commercialEvidenceHash",
	"defaultDeductionApplied",
	"defaultDeductionRate",
	"payoutFallbackReason",
	"source",
	"provider",
	"providerLabel",
	"sourceCurrency",
	"propertyCurrency",
	"sourceAmount",
	"sourceGuestGross",
	"sourceHotelPayout",
	"propertyConversionVerified",
	"hotelRunnerAmountRole",
	"sourceExchangeRateToSar",
	"sourceExchangeRateSource",
	"exchangeRateToSar",
	"exchangeRateSource",
	"amountConvertedAt",
]);
const SUMMARY_COMMERCIAL_FIELDS = Object.freeze([
	"show",
	"source",
	"provider",
	"providerLabel",
	"currency",
	"clientTotal",
	"netAfterExpenses",
	"netAfterOtaExpenses",
	"otaExpenseTotal",
	"platformProfit",
	"commissionAmount",
	"otaCommissionAmount",
	"otaDeductionBreakdown",
	"unclassifiedOtaDeduction",
	"commercialVerified",
	"commercialVerificationState",
	"commercialEvidenceHash",
	"sourceCurrency",
	"propertyCurrency",
	"sourceAmount",
	"sourceGuestGross",
	"sourceHotelPayout",
	"propertyConversionVerified",
	"hotelRunnerAmountRole",
	"paymentCollectionModel",
	"payoutFallbackReason",
	"paymentSummary",
	"sourceExchangeRateToSar",
	"sourceExchangeRateSource",
	"exchangeRateToSar",
	"exchangeRateSource",
	"amountConvertedAt",
]);
const SUPPLIER_COMMERCIAL_FIELDS = Object.freeze([
	"otaAmount",
	"otaAmountSar",
	"otaAmountConvertedAt",
	"otaCurrency",
	"otaSourceCurrency",
	"otaSourceAmount",
	"otaSourceAmountHint",
	"otaPropertyCurrency",
	"otaExchangeRateToSar",
	"otaExchangeRateSource",
	"otaSourceExchangeRateToSar",
	"otaSourceExchangeRateSource",
	"otaPaymentSummary",
	"otaPaymentCollectionModel",
	"otaDeductionComponents",
	"otaTotalPayoutSar",
	"otaExpenseTotalSar",
	"otaPlatformMarginSar",
	"otaCommissionSar",
	"otaCommissionSource",
	"otaCommissionSourceBacked",
	"otaPayoutFallbackReason",
	"otaCommercialEvidence",
	"otaCommercialRepair",
]);

const clean = (value = "") => String(value?._id || value || "").trim();
const lower = (value = "") => clean(value).toLowerCase();
const upper = (value = "") => clean(value).toUpperCase();
const round2 = (value) => Number(Number(value).toFixed(2));
const sameMoney = (left, right) =>
	Number.isFinite(Number(left)) &&
	Number.isFinite(Number(right)) &&
	Math.abs(round2(left) - round2(right)) < 0.005;
const dateKey = (value) => {
	const parsed = value instanceof Date ? value : new Date(value);
	return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : "";
};
const sha256 = (value) =>
	crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");

function fail(message, code = "EXPEDIA_COMMERCIAL_REPAIR_BLOCKED") {
	const error = new Error(message);
	error.code = code;
	throw error;
}

function objectId(value, label = "Mongo id") {
	const text = clean(value);
	if (!ObjectId.isValid(text)) fail(`${label} is invalid.`, "EXPEDIA_REPAIR_ID_INVALID");
	return new ObjectId(text);
}

function parseArguments(argv = []) {
	let apply = false;
	let rollback = false;
	let repairId = "";
	let releaseSha = "";
	let proof = "";
	let portalJobId = "";
	let portalJobNumber = "";
	for (const raw of argv) {
		const argument = clean(raw);
		if (argument === "--apply") {
			if (apply) fail("--apply may be supplied only once.", "EXPEDIA_REPAIR_ARGUMENT_INVALID");
			apply = true;
			continue;
		}
		if (argument === "--rollback") {
			if (rollback) fail("--rollback may be supplied only once.", "EXPEDIA_REPAIR_ARGUMENT_INVALID");
			rollback = true;
			continue;
		}
		let recognized = false;
		for (const [prefix, prior, assign] of [
			["--repair-id=", repairId, (value) => (repairId = value)],
			["--release-sha=", releaseSha, (value) => (releaseSha = lower(value))],
			["--proof=", proof, (value) => (proof = lower(value))],
			["--portal-job-id=", portalJobId, (value) => (portalJobId = lower(value))],
			[
				"--portal-job-number=",
				portalJobNumber,
				(value) => (portalJobNumber = upper(value)),
			],
		]) {
			if (!argument.startsWith(prefix)) continue;
			if (prior) fail(`${prefix.slice(0, -1)} may be supplied only once.`, "EXPEDIA_REPAIR_ARGUMENT_INVALID");
			assign(argument.slice(prefix.length));
			recognized = true;
			break;
		}
		if (!recognized) fail("Unsupported Expedia repair argument.", "EXPEDIA_REPAIR_ARGUMENT_INVALID");
	}
	if (!/^[a-f0-9]{40}$/.test(releaseSha)) {
		fail("An exact 40-character --release-sha is required.", "EXPEDIA_REPAIR_RELEASE_REQUIRED");
	}
	if (!apply && !rollback && (repairId || proof)) {
		fail("--repair-id and --proof are apply-only for a forward repair.", "EXPEDIA_REPAIR_ARGUMENT_INVALID");
	}
	if (rollback && repairId !== REPAIR_ID) {
		fail(`Rollback requires --repair-id=${REPAIR_ID}.`, "EXPEDIA_REPAIR_ID_REQUIRED");
	}
	if (apply && repairId !== REPAIR_ID) {
		fail(`Apply requires --repair-id=${REPAIR_ID}.`, "EXPEDIA_REPAIR_ID_REQUIRED");
	}
	if (apply && !/^\d{13}\.[a-f0-9]{64}$/.test(proof)) {
		fail("Apply requires the exact unexpired dry-run proof.", "EXPEDIA_REPAIR_PROOF_REQUIRED");
	}
	if (!apply && proof) {
		fail("--proof is accepted only with --apply.", "EXPEDIA_REPAIR_ARGUMENT_INVALID");
	}
	if (Boolean(portalJobId) !== Boolean(portalJobNumber)) {
		fail(
			"A custom portal source requires both --portal-job-id and --portal-job-number.",
			"EXPEDIA_REPAIR_PORTAL_SELECTION_INCOMPLETE"
		);
	}
	if (portalJobId && !/^[a-f0-9]{24}$/.test(portalJobId)) {
		fail("--portal-job-id must be an exact Mongo ObjectId.", "EXPEDIA_REPAIR_PORTAL_SELECTION_INVALID");
	}
	if (
		portalJobNumber &&
		!/^OTA-RES-SYNC-\d{14}-[A-Z0-9]{5}$/.test(portalJobNumber)
	) {
		fail(
			"--portal-job-number must be an exact OTA reservation sync job number.",
			"EXPEDIA_REPAIR_PORTAL_SELECTION_INVALID"
		);
	}
	return {
		apply,
		rollback,
		repairId,
		releaseSha,
		proof,
		portalJobId,
		portalJobNumber,
	};
}

function normalizePortalSelection(value = DEFAULT_PORTAL_SELECTION) {
	const suppliedJobId = clean(value?.jobId);
	const suppliedJobNumber = clean(value?.jobNumber);
	if (Boolean(suppliedJobId) !== Boolean(suppliedJobNumber)) {
		fail(
			"The selected portal job requires both its exact ID and job number.",
			"EXPEDIA_REPAIR_PORTAL_SELECTION_INCOMPLETE"
		);
	}
	const jobId = lower(suppliedJobId || DEFAULT_PORTAL_SELECTION.jobId);
	const jobNumber = upper(
		suppliedJobNumber || DEFAULT_PORTAL_SELECTION.jobNumber
	);
	if (
		!/^[a-f0-9]{24}$/.test(jobId) ||
		!/^OTA-RES-SYNC-\d{14}-[A-Z0-9]{5}$/.test(jobNumber)
	) {
		fail("The selected portal job identity is invalid.", "EXPEDIA_REPAIR_PORTAL_SELECTION_INVALID");
	}
	return Object.freeze({ jobId, jobNumber });
}

function portalSelectionFromArguments(options = {}) {
	return normalizePortalSelection(
		options.portalJobId
			? { jobId: options.portalJobId, jobNumber: options.portalJobNumber }
			: DEFAULT_PORTAL_SELECTION
	);
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
		fail("Could not resolve the deployed Git release SHA.", "EXPEDIA_REPAIR_RELEASE_UNRESOLVED");
	}
}

function assertRelease(expected, actual) {
	if (!/^[a-f0-9]{40}$/.test(lower(actual)) || lower(actual) !== lower(expected)) {
		fail(
			"The deployed checkout does not equal the explicitly approved merge SHA.",
			"EXPEDIA_REPAIR_RELEASE_MISMATCH"
		);
	}
}

function parseProof(proof, now = new Date()) {
	const match = lower(proof).match(/^(\d{13})\.([a-f0-9]{64})$/);
	if (!match) fail("The dry-run proof format is invalid.", "EXPEDIA_REPAIR_PROOF_INVALID");
	const plannedAtMs = Number(match[1]);
	const nowMs = now.getTime();
	if (
		!Number.isSafeInteger(plannedAtMs) ||
		plannedAtMs > nowMs + 5_000 ||
		nowMs - plannedAtMs > PROOF_MAX_AGE_MS
	) {
		fail("The dry-run proof is expired or from the future.", "EXPEDIA_REPAIR_PROOF_EXPIRED");
	}
	return { plannedAt: new Date(plannedAtMs), planHash: match[2] };
}

const sortCanonical = (value) => {
	if (Array.isArray(value)) return value.map(sortCanonical);
	if (!value || typeof value !== "object") return value;
	return Object.keys(value)
		.sort()
		.reduce((result, key) => {
			result[key] = sortCanonical(value[key]);
			return result;
		}, {});
};

function canonicalEjsonString(value) {
	return JSON.stringify(sortCanonical(EJSON.serialize(value, { relaxed: false })));
}

const canonicalEqual = (left, right) =>
	canonicalEjsonSha256(left) === canonicalEjsonSha256(right);

function deleteKeys(object, keys) {
	if (!object || typeof object !== "object") return;
	for (const key of keys) delete object[key];
}

function commercialProtectedSnapshot(document = {}) {
	const snapshot = cloneBson(document);
	deleteKeys(snapshot, ["total_amount", "commission", "commission_ota", "updatedAt", "__v"]);
	snapshot.reservationAuditLog = (Array.isArray(snapshot.reservationAuditLog)
		? snapshot.reservationAuditLog
		: []
	).filter((entry) => clean(entry?.repairId) !== REPAIR_ID);
	for (const rooms of [snapshot.pickedRoomsType, snapshot.pickedRoomsPricing]) {
		for (const room of Array.isArray(rooms) ? rooms : []) {
			deleteKeys(room, COMMERCIAL_ROOM_FIELDS);
			for (const day of Array.isArray(room.pricingByDay) ? room.pricingByDay : []) {
				deleteKeys(day, [...COMMERCIAL_DAY_FIELDS, "commercialVerification"]);
			}
		}
	}
	deleteKeys(snapshot.adminPricing, ADMIN_COMMERCIAL_FIELDS);
	deleteKeys(snapshot.ota_financial_summary, SUMMARY_COMMERCIAL_FIELDS);
	deleteKeys(snapshot.supplierData, SUPPLIER_COMMERCIAL_FIELDS);
	return snapshot;
}

function rootEvidenceProjection(reservation = {}) {
	return {
		reservationMongoId: clean(reservation._id),
		subTotal: reservation.sub_total,
		adminRootTotal: reservation.adminPricing?.rootTotal,
		hotelVisibleAmount: reservation.ota_financial_summary?.hotelVisibleAmount,
		rooms: (Array.isArray(reservation.pickedRoomsPricing)
			? reservation.pickedRoomsPricing
			: []
		).map((room) => ({
			hotelRoomConfigId: clean(room?.hotelRoomConfigId || room?.localRoomConfigId),
			hotelShouldGet: room?.hotelShouldGet,
			count: room?.count,
			pricingByDay: (Array.isArray(room?.pricingByDay) ? room.pricingByDay : []).map(
				(day) => ({
					date: dateKey(day?.date),
					rootPrice: day?.rootPrice,
					totalPriceWithoutCommission: day?.totalPriceWithoutCommission,
				})
			),
		})),
	};
}

function flattenDays(rooms = []) {
	return (Array.isArray(rooms) ? rooms : []).flatMap((room) =>
		(Array.isArray(room?.pricingByDay) ? room.pricingByDay : []).map((day) => ({
			room,
			day,
		}))
	);
}

function assertRootBoundary(reservation) {
	if (
		!sameMoney(reservation?.sub_total, TARGET.rootTotal) ||
		!sameMoney(reservation?.adminPricing?.rootTotal, TARGET.rootTotal) ||
		!sameMoney(
			reservation?.ota_financial_summary?.hotelVisibleAmount,
			TARGET.rootTotal
		)
	) {
		fail("The protected SAR 534 hotel base aggregate changed.");
	}
	for (const field of ["pickedRoomsType", "pickedRoomsPricing"]) {
		const rooms = reservation?.[field];
		const rows = flattenDays(rooms);
		if (!Array.isArray(rooms) || rooms.length !== 1 || rows.length !== TARGET.nights) {
			fail(`${field} no longer contains the exact one-room six-night root boundary.`);
		}
		if (Number(rooms[0]?.count || 1) !== 1 || !sameMoney(rooms[0]?.hotelShouldGet, TARGET.rootTotal)) {
			fail(`${field} protected room/root aggregate changed.`);
		}
		for (let index = 0; index < rows.length; index += 1) {
			const expectedDate = new Date(`${TARGET.checkinDate}T00:00:00.000Z`);
			expectedDate.setUTCDate(expectedDate.getUTCDate() + index);
			if (
				dateKey(rows[index].day?.date) !== expectedDate.toISOString().slice(0, 10) ||
				!sameMoney(rows[index].day?.rootPrice, TARGET.dailyRoot[index]) ||
				(rows[index].day?.totalPriceWithoutCommission != null &&
					!sameMoney(rows[index].day.totalPriceWithoutCommission, TARGET.dailyRoot[index]))
			) {
				fail(`${field} protected root row ${index + 1} changed.`);
			}
		}
	}
}

function assertReservationIdentity(reservation) {
	const identityValues = [
		lower(reservation?.otaIdentityKey),
		lower(reservation?.otaCrossTransportIdentityKey),
	].filter(Boolean);
	const supplier = reservation?.supplierData || {};
	const hotelRunner = supplier.hotelRunner || {};
	if (
		clean(reservation?._id) !== TARGET.reservationMongoId ||
		clean(reservation?.hotelId) !== TARGET.hotelId ||
		clean(reservation?.confirmation_number) !== TARGET.pmsConfirmationNumber ||
		clean(reservation?.reservation_id) !== TARGET.otaBookingId ||
		!identityValues.includes(TARGET.otaIdentityKey) ||
		clean(reservation?.customer_details?.confirmation_number2) !== TARGET.otaBookingId ||
		dateKey(reservation?.checkin_date) !== TARGET.checkinDate ||
		dateKey(reservation?.checkout_date) !== TARGET.checkoutDate ||
		Number(reservation?.days_of_residence || TARGET.nights) !== TARGET.nights ||
		Number(reservation?.total_rooms) !== 1 ||
		upper(reservation?.currency) !== TARGET.propertyCurrency ||
		lower(reservation?.booking_source) !== "expedia" ||
		clean(supplier?.otaConfirmationNumber) !== TARGET.otaBookingId ||
		clean(supplier?.platformConfirmationNumber) !== TARGET.otaBookingId ||
		lower(supplier?.otaProvider) !== "expedia" ||
		lower(hotelRunner?.transport) !== "hotelrunner_api" ||
		clean(hotelRunner?.reservationId) !== TARGET.hotelRunnerReservationId ||
		upper(hotelRunner?.hrNumber) !== TARGET.hrNumber ||
		clean(hotelRunner?.providerNumber) !== TARGET.otaBookingId
	) {
		fail("The exact Expedia/HotelRunner PMS identity, stay, or ownership boundary changed.");
	}
	assertRootBoundary(reservation);
}

function assertPreRepairCommercialState(reservation) {
	if (
		Number(reservation?.__v) !== TARGET.reservationVersion ||
		!sameMoney(reservation?.total_amount, TARGET.oldCanonicalClientTotal) ||
		!sameMoney(reservation?.adminPricing?.clientTotal, TARGET.oldCanonicalClientTotal) ||
		!sameMoney(
			reservation?.adminPricing?.netAfterExpensesTotal,
			TARGET.oldCanonicalClientTotal
		) ||
		!sameMoney(
			reservation?.ota_financial_summary?.clientTotal,
			TARGET.oldCanonicalClientTotal
		) ||
		!sameMoney(
			reservation?.ota_financial_summary?.netAfterExpenses,
			TARGET.oldCanonicalClientTotal
		) ||
		Number(reservation?.commission) !== 0 ||
		reservation?.commission_ota !== null
	) {
		fail("The reservation no longer has the exact audited false canonical pre-repair state.");
	}
	if (!canonicalEqual(reservation.pickedRoomsType, reservation.pickedRoomsPricing)) {
		fail("The two exact room pricing projections diverged before repair.");
	}
	const rows = flattenDays(reservation.pickedRoomsPricing);
	for (let index = 0; index < rows.length; index += 1) {
		const day = rows[index].day;
		if (
			!sameMoney(day?.clientPrice, TARGET.dailyFalseCanonical[index]) ||
			!sameMoney(day?.netAfterExpenses, TARGET.dailyFalseCanonical[index]) ||
			(day?.netAfterOtaExpenses != null &&
				!sameMoney(day.netAfterOtaExpenses, TARGET.dailyFalseCanonical[index])) ||
			(day?.hotelRunnerSourcePrice != null &&
				!sameMoney(day.hotelRunnerSourcePrice, TARGET.dailyHotelRunnerSource[index]))
		) {
			fail(`The audited false/source nightly row ${index + 1} changed.`);
		}
		for (const field of ["price", "mainPrice", "totalPriceWithCommission"]) {
			if (day?.[field] != null && !sameMoney(day[field], TARGET.dailyFalseCanonical[index])) {
				fail(`The audited ${field} nightly projection changed.`);
			}
		}
	}
	const pricing = reservation?.supplierData?.hotelRunner?.pricing || {};
	const rawNightly = (Array.isArray(pricing.rooms) ? pricing.rooms : []).flatMap(
		(room) => (Array.isArray(room?.nightly) ? room.nightly : [])
	);
	if (
		upper(pricing.currency) !== TARGET.sourceCurrency ||
		!sameMoney(pricing.grandTotal, TARGET.hotelRunnerReportedAmount) ||
		pricing.hotelNetPayout !== null ||
		pricing.otaCommission !== null ||
		rawNightly.length !== TARGET.nights ||
		rawNightly.some((day, index) => {
			const expectedDate = new Date(`${TARGET.checkinDate}T00:00:00.000Z`);
			expectedDate.setUTCDate(expectedDate.getUTCDate() + index);
			return (
				dateKey(day?.date) !== expectedDate.toISOString().slice(0, 10) ||
				!sameMoney(day?.finalPrice, TARGET.dailyHotelRunnerSource[index])
			);
		})
	) {
		fail("The immutable HotelRunner USD 112.92 source evidence changed.");
	}
}

function assertHotelRunnerEnvelope(event, mirror) {
	if (
		clean(event?._id) !== TARGET.eventId ||
		clean(event?.hotelId) !== TARGET.hotelId ||
		clean(event?.hotelRunnerReservationId) !== TARGET.hotelRunnerReservationId ||
		upper(event?.hrNumber) !== TARGET.hrNumber ||
		clean(event?.providerNumber) !== TARGET.otaBookingId ||
		lower(event?.channel) !== "expedia" ||
		lower(event?.source) !== "push" ||
		lower(event?.status) !== TARGET.eventStatus ||
		lower(event?.payloadHash) !== TARGET.eventPayloadHash ||
		lower(event?.canonicalHash) !== TARGET.eventCanonicalHash ||
		clean(event?.reservationMongoId) !== TARGET.reservationMongoId ||
		clean(event?.mirrorId) !== TARGET.mirrorId ||
		event?.integrityConflict === true ||
		clean(event?.integrityReason) ||
		!event?.payload ||
		typeof event.payload !== "object"
	) {
		fail("The exact archived HotelRunner event/raw-payload envelope changed.");
	}
	if (
		clean(mirror?._id) !== TARGET.mirrorId ||
		clean(mirror?.hotelId) !== TARGET.hotelId ||
		clean(mirror?.hotelRunnerReservationId) !== TARGET.hotelRunnerReservationId ||
		upper(mirror?.hrNumber) !== TARGET.hrNumber ||
		clean(mirror?.providerNumber) !== TARGET.otaBookingId ||
		lower(mirror?.channel) !== "expedia" ||
		lower(mirror?.observedCanonicalHash) !== TARGET.eventCanonicalHash ||
		lower(mirror?.appliedCanonicalHash) !== TARGET.eventCanonicalHash ||
		Number(mirror?.projectionVersion) !== 1 ||
		clean(mirror?.reservationMongoId) !== TARGET.reservationMongoId ||
		mirror?.identityConflict === true
	) {
		fail("The exact HotelRunner mirror/ownership envelope changed.");
	}
}

function portalCandidate(job) {
	const candidates = (Array.isArray(job?.previewBuckets?.matchedExisting)
		? job.previewBuckets.matchedExisting
		: []
	).filter(
		(candidate) =>
			clean(candidate?.confirmationNumber) === TARGET.otaBookingId ||
			clean(candidate?.matchedLookupValue) === TARGET.otaBookingId
	);
	if (candidates.length !== 1) {
		fail(`The exact portal preview requires one matched-existing Expedia row; found ${candidates.length}.`);
	}
	return candidates[0];
}

function explicitPortalPayout(candidate) {
	const payout = Number(candidate?.paymentSummary?.sourceTotalPayoutAmount || 0);
	if (!Number.isFinite(payout) || payout < 0) fail("The portal payout evidence is malformed.");
	if (payout === 0) return null;
	if (
		candidate?.detailsFetched !== true ||
		upper(candidate?.paymentSummary?.sourceCurrency || candidate?.sourceCurrency) !==
			TARGET.sourceCurrency ||
		payout > TARGET.portalGuestGross + 0.004
	) {
		fail("A portal payout appeared without compatible authenticated USD detail-page proof.");
	}
	return round2(payout);
}


function assertPortalJob(job, portalSelection = DEFAULT_PORTAL_SELECTION) {
	const selected = normalizePortalSelection(portalSelection);
	const allowedDateFrom = new Set([
		TARGET.portalDateFrom,
		TARGET.checkinDate,
	]);
	const allowedDateTo = new Set([
		TARGET.checkoutDate,
		TARGET.portalDateTo,
	]);
	if (
		clean(job?._id) !== selected.jobId ||
		clean(job?.jobNumber) !== selected.jobNumber ||
		lower(job?.provider) !== "expedia" ||
		lower(job?.operation) !== "reservation_sync_preview" ||
		lower(job?.executionMode) !== "supervised_read_only" ||
		lower(job?.status) !== "preview_ready" ||
		job?.collectorState?.readOnly !== true ||
		!allowedDateFrom.has(clean(job?.dateFrom)) ||
		!allowedDateTo.has(clean(job?.dateTo)) ||
		Number(job?.resultSummary?.appliedWrites || 0) !== 0
	) {
		fail("The exact supervised read-only Expedia portal job boundary changed.");
	}
	const targetHotels = Array.isArray(job.targetHotels) ? job.targetHotels : [];
	const selectedHotelIds = Array.isArray(job?.collectorState?.selectedHotelIds)
		? job.collectorState.selectedHotelIds.map(clean)
		: [];
	if (
		!targetHotels.some((hotel) => clean(hotel?.hotelId) === TARGET.hotelId) ||
		selectedHotelIds.length !== 1 ||
		selectedHotelIds[0] !== TARGET.hotelId ||
		Number(job?.collectorState?.selectedHotelCount) !== 1
	) {
		fail("The Expedia portal collection run no longer has the exact one-hotel audited scope.");
	}
	const finishedAudit = (Array.isArray(job.auditLog) ? job.auditLog : []).find(
		(entry) => clean(entry?.action) === "collector_finished" && entry?.readOnly === true
	);
	if (!finishedAudit) fail("The portal job lacks its immutable read-only completion audit.");
	const candidate = portalCandidate(job);
	const summary = candidate.paymentSummary || {};
	const grossValues = [
		candidate.sourceAmount,
		summary.sourceTotalGuestPaymentAmount,
	].filter((value) => Number(value) > 0);
	if (
		clean(candidate?.hotelId) !== TARGET.hotelId ||
		clean(candidate?.confirmationNumber) !== TARGET.otaBookingId ||
		clean(candidate?.reservationId) !== TARGET.reservationMongoId ||
		clean(candidate?.pmsConfirmationNumber) !== TARGET.pmsConfirmationNumber ||
		clean(candidate?.matchedLookupValue) !== TARGET.otaBookingId ||
		clean(candidate?.actionPreview) !== "matched_existing_no_write" ||
		dateKey(candidate?.checkinDate) !== TARGET.checkinDate ||
		dateKey(candidate?.checkoutDate) !== TARGET.checkoutDate ||
		upper(candidate?.sourceCurrency || summary.sourceCurrency) !== TARGET.sourceCurrency ||
		lower(candidate?.paymentCollectionModel) !== "expedia_collect" ||
		candidate?.propertyConversionVerified === true ||
		summary?.propertyConversionVerified === true ||
		grossValues.length === 0 ||
		grossValues.some((value) => !sameMoney(value, TARGET.portalGuestGross))
	) {
		fail("The authenticated portal row no longer proves the exact Expedia Collect USD 146.46 gross.");
	}
	for (const value of [candidate?.explicitOtaCommission, summary?.explicitOtaCommission]) {
		if (value != null && Number(value) !== 0) {
			fail("An explicit commission appeared and requires a new reviewed repair plan.");
		}
	}
	explicitPortalPayout(candidate);
	return candidate;
}

function sourceOnlyPaymentSummary(
	candidate,
	sourceJobHash,
	portalSelection = DEFAULT_PORTAL_SELECTION
) {
	const selected = normalizePortalSelection(portalSelection);
	const summary = candidate?.paymentSummary || {};
	const payout = explicitPortalPayout(candidate);
	const sourceMoney = (value) => {
		const number = Number(value || 0);
		return Number.isFinite(number) && number > 0 ? round2(number) : null;
	};
	return {
		sourceType: "authenticated_provider_portal",
		sourceJobId: selected.jobId,
		sourceJobNumber: selected.jobNumber,
		sourceJobHash,
		paymentCollectionModel: "ota_collect",
		sourceCurrency: TARGET.sourceCurrency,
		propertyCurrency: TARGET.propertyCurrency,
		sourceTotalGuestPaymentAmount: TARGET.portalGuestGross,
		sourceNightlyRateAmount: sourceMoney(summary.sourceNightlyRateAmount),
		sourceTaxesAmount: sourceMoney(summary.sourceTaxesAmount),
		sourceExpediaCompensationAmount: sourceMoney(
			summary.sourceExpediaCompensationAmount
		),
		sourceAcceleratorAmount: sourceMoney(summary.sourceAcceleratorAmount),
		sourceTotalPayoutAmount: payout,
		totalGuestPaymentAmount: null,
		nightlyRateAmount: null,
		taxesAmount: null,
		expediaCompensationAmount: null,
		acceleratorAmount: null,
		totalPayoutAmount: null,
		currency: null,
		propertyConversionVerified: false,
		exchangeRateToSar: null,
		exchangeRateSource: "",
		amountConvertedAt: "",
	};
}

function buildCommercialEvidence({
	reservation,
	event,
	job,
	portalSelection = DEFAULT_PORTAL_SELECTION,
}) {
	const selected = normalizePortalSelection(portalSelection);
	const candidate = assertPortalJob(job, selected);
	const sourceJobHash = canonicalEjsonSha256(job);
	const rootHash = canonicalEjsonSha256(rootEvidenceProjection(reservation));
	const payout = explicitPortalPayout(candidate);
	const hotelRunnerPayoutMatch =
		payout !== null && sameMoney(payout, TARGET.hotelRunnerReportedAmount);
	const sourceTimestamp =
		job?.collectorState?.finishedAt || job?.updatedAt || job?.createdAt;
	const hotelRunnerTimestamp = event?.sourceUpdatedAt || event?.receivedAt || event?.createdAt;
	const hotelBaseTimestamp = reservation?.createdAt || event?.sourceUpdatedAt || sourceTimestamp;
	const evidence = buildAuthenticatedProviderCommercialEvidence({
		provider: "expedia",
		authenticatedProvider: "expedia",
		sourceAuthenticated: true,
		sourceTrusted: true,
		sourceType: "authenticated_provider_portal",
		sourceCurrency: TARGET.sourceCurrency,
		propertyCurrency: TARGET.propertyCurrency,
		bookingBasis: "reservation_total",
		sourceHash: sourceJobHash,
		sourceTimestamp,
		sourceId: selected.jobId,
		guestGross: {
			verified: true,
			amount: TARGET.portalGuestGross,
			currency: TARGET.sourceCurrency,
		},
		hotelPayout: payout
			? {
					verified: true,
					amount: payout,
					currency: TARGET.sourceCurrency,
			  }
			: undefined,
		hotelBase: {
			verified: true,
			amount: TARGET.rootTotal,
			currency: TARGET.propertyCurrency,
			provenance: {
				provider: "jannat_pms",
				sourceType: "pms_root_pricing",
				sourceHash: rootHash,
				sourceTimestamp: hotelBaseTimestamp,
				sourceId: `${TARGET.reservationMongoId}:root-pricing`,
			},
		},
		hotelRunnerReportedAmount: {
			amount: TARGET.hotelRunnerReportedAmount,
			currency: TARGET.sourceCurrency,
			role: hotelRunnerPayoutMatch ? "hotel_payout" : "unknown",
			explicitRoleAssignment: hotelRunnerPayoutMatch,
			provenance: {
				provider: "expedia",
				sourceType: "hotelrunner_webhook",
				sourceHash: TARGET.eventPayloadHash,
				sourceTimestamp: hotelRunnerTimestamp,
				sourceId: TARGET.eventId,
			},
		},
	});
	const validation = validateOtaCommercialEvidence(evidence);
	if (!validation.ok) {
		fail(`The common commercial evidence contract failed: ${validation.errors.join(",")}.`);
	}
	if (
		evidence.roles.guestGross.sourceAmount !== TARGET.portalGuestGross ||
		evidence.roles.guestGross.propertyAmount !== null ||
		evidence.roles.hotelBase.propertyAmount !== TARGET.rootTotal ||
		evidence.roles.explicitOtaCommission.verified !== false ||
		evidence.currencyConversion !== null
	) {
		fail("The common contract attempted an unsafe property-currency or commission projection.");
	}
	return {
		candidate,
		evidence,
		sourceJobHash,
		rootHash,
		payout,
		hotelRunnerPayoutMatch,
		portalSelection: selected,
	};
}

function nullCommercialRooms(rooms = []) {
	return (Array.isArray(rooms) ? rooms : []).map((sourceRoom) => {
		const room = cloneBson(sourceRoom);
		for (const field of COMMERCIAL_ROOM_FIELDS) room[field] = null;
		room.pricingByDay = (Array.isArray(room.pricingByDay)
			? room.pricingByDay
			: []
		).map((sourceDay) => {
			const day = cloneBson(sourceDay);
			for (const field of COMMERCIAL_DAY_FIELDS) day[field] = null;
			day.commercialVerification = "partial_source_currency_only";
			return day;
		});
		return room;
	});
}

function payoutFallbackReason(payout) {
	return payout
		? "property_currency_conversion_not_verified"
		: "authenticated_expedia_payout_not_provided";
}

function repairAuditEntry({
	releaseSha,
	repairAt,
	originalHash,
	evidence,
	sourceJobHash,
	portalSelection = DEFAULT_PORTAL_SELECTION,
}) {
	const selected = normalizePortalSelection(portalSelection);
	return {
		at: new Date(repairAt),
		source: "guarded-expedia-commercial-repair",
		action: "fail-closed-source-currency-commercial-enrichment",
		provider: "expedia",
		repairId: REPAIR_ID,
		releaseSha: lower(releaseSha),
		reservationId: TARGET.otaBookingId,
		pmsConfirmationNumber: TARGET.pmsConfirmationNumber,
		hotelRunnerEventId: TARGET.eventId,
		hotelRunnerMirrorId: TARGET.mirrorId,
		sourceJobId: selected.jobId,
		sourceJobNumber: selected.jobNumber,
		sourceJobHash,
		evidenceHash: evidence.evidenceHash,
		originalDocumentHash: originalHash,
		backupCollection: BACKUP_COLLECTION,
		vendorApiCalls: 0,
	};
}

function buildExpectedDocument({
	reservation,
	event,
	job,
	releaseSha,
	repairAt,
	portalSelection = DEFAULT_PORTAL_SELECTION,
}) {
	const selected = normalizePortalSelection(portalSelection);
	const originalHash = canonicalEjsonSha256(reservation);
	const {
		candidate,
		evidence,
		sourceJobHash,
		rootHash,
		payout,
		hotelRunnerPayoutMatch,
	} =
		buildCommercialEvidence({
			reservation,
			event,
			job,
			portalSelection: selected,
		});
	const next = cloneBson(reservation);
	const rooms = nullCommercialRooms(reservation.pickedRoomsPricing);
	const fallbackReason = payoutFallbackReason(payout);
	const paymentSummary = sourceOnlyPaymentSummary(
		candidate,
		sourceJobHash,
		selected
	);
	next.total_amount = null;
	next.commission = 0;
	next.commission_ota = null;
	next.pickedRoomsType = cloneBson(rooms);
	next.pickedRoomsPricing = cloneBson(rooms);
	next.adminPricing = {
		...(next.adminPricing || {}),
		clientTotal: null,
		netAfterExpensesTotal: null,
		otaExpenseTotal: null,
		platformMarginTotal: null,
		commissionAmount: 0,
		commercialVerified: false,
		commercialVerificationState: evidence.verificationState,
		commercialEvidenceHash: evidence.evidenceHash,
		defaultDeductionApplied: false,
		defaultDeductionRate: null,
		payoutFallbackReason: fallbackReason,
		source: "authenticated_provider_portal",
		provider: "expedia",
		providerLabel: "Expedia",
		sourceCurrency: TARGET.sourceCurrency,
		propertyCurrency: TARGET.propertyCurrency,
		sourceAmount: TARGET.portalGuestGross,
		sourceGuestGross: TARGET.portalGuestGross,
		sourceHotelPayout: payout,
		propertyConversionVerified: false,
		hotelRunnerAmountRole: hotelRunnerPayoutMatch
			? "hotel_payout"
			: "unknown",
		sourceExchangeRateToSar: null,
		sourceExchangeRateSource: "",
		exchangeRateToSar: null,
		exchangeRateSource: "",
		amountConvertedAt: null,
	};
	next.ota_financial_summary = {
		...(next.ota_financial_summary || {}),
		show: true,
		source: "authenticated_provider_portal",
		provider: "expedia",
		providerLabel: "Expedia",
		currency: TARGET.propertyCurrency,
		clientTotal: null,
		netAfterExpenses: null,
		netAfterOtaExpenses: null,
		otaExpenseTotal: null,
		platformProfit: null,
		commissionAmount: 0,
		otaCommissionAmount: null,
		otaDeductionBreakdown: [],
		unclassifiedOtaDeduction: null,
		commercialVerified: false,
		commercialVerificationState: evidence.verificationState,
		commercialEvidenceHash: evidence.evidenceHash,
		sourceCurrency: TARGET.sourceCurrency,
		propertyCurrency: TARGET.propertyCurrency,
		sourceAmount: TARGET.portalGuestGross,
		sourceGuestGross: TARGET.portalGuestGross,
		sourceHotelPayout: payout,
		propertyConversionVerified: false,
		hotelRunnerAmountRole: hotelRunnerPayoutMatch
			? "hotel_payout"
			: "unknown",
		paymentCollectionModel: "ota_collect",
		payoutFallbackReason: fallbackReason,
		paymentSummary,
		sourceExchangeRateToSar: null,
		sourceExchangeRateSource: "",
		exchangeRateToSar: null,
		exchangeRateSource: "",
		amountConvertedAt: null,
	};
	next.supplierData = {
		...(next.supplierData || {}),
		otaAmount: TARGET.portalGuestGross,
		otaAmountSar: null,
		otaAmountConvertedAt: null,
		otaCurrency: TARGET.sourceCurrency,
		otaSourceCurrency: TARGET.sourceCurrency,
		otaSourceAmount: TARGET.portalGuestGross,
		otaSourceAmountHint: `${TARGET.sourceCurrency} ${TARGET.portalGuestGross.toFixed(2)}`,
		otaPropertyCurrency: TARGET.propertyCurrency,
		otaExchangeRateToSar: null,
		otaExchangeRateSource: "",
		otaSourceExchangeRateToSar: null,
		otaSourceExchangeRateSource: "",
		otaPaymentSummary: paymentSummary,
		otaPaymentCollectionModel: "ota_collect",
		otaDeductionComponents: [],
		otaTotalPayoutSar: null,
		otaExpenseTotalSar: null,
		otaPlatformMarginSar: null,
		otaCommissionSar: null,
		otaCommissionSource: "",
		otaCommissionSourceBacked: false,
		otaPayoutFallbackReason: fallbackReason,
		otaCommercialEvidence: cloneBson(evidence),
		otaCommercialRepair: {
			repairId: REPAIR_ID,
			releaseSha: lower(releaseSha),
			appliedAt: new Date(repairAt),
			sourceJobId: selected.jobId,
			sourceJobNumber: selected.jobNumber,
			sourceJobHash,
			evidenceHash: evidence.evidenceHash,
			rootEvidenceHash: rootHash,
			originalDocumentHash: originalHash,
			canonicalPropertyAmountsCleared: true,
			vendorApiCalls: 0,
		},
	};
	next.reservationAuditLog = [
		...(Array.isArray(next.reservationAuditLog) ? next.reservationAuditLog : []),
		repairAuditEntry({
			releaseSha,
			repairAt,
			originalHash,
			evidence,
			sourceJobHash,
			portalSelection: selected,
		}),
	];
	next.updatedAt = new Date(repairAt);
	next.__v = TARGET.reservationVersion + 1;
	assertPostconditions({
		before: reservation,
		after: next,
		evidence,
		payout,
		portalSelection: selected,
	});
	return {
		expectedDocument: next,
		evidence,
		sourceJobHash,
		rootHash,
		payout,
		portalSelection: selected,
	};
}

function assertPostconditions({
	before,
	after,
	evidence,
	payout,
	portalSelection = DEFAULT_PORTAL_SELECTION,
}) {
	const selected = normalizePortalSelection(portalSelection);
	assertReservationIdentity(after);
	const validation = validateOtaCommercialEvidence(
		after?.supplierData?.otaCommercialEvidence
	);
	if (!validation.ok || after.supplierData.otaCommercialEvidence.evidenceHash !== evidence.evidenceHash) {
		fail(`Persisted commercial evidence is invalid: ${validation.errors.join(",")}.`);
	}
	if (
		after.total_amount !== null ||
		after.adminPricing?.clientTotal !== null ||
		after.adminPricing?.netAfterExpensesTotal !== null ||
		after.adminPricing?.otaExpenseTotal !== null ||
		after.adminPricing?.platformMarginTotal !== null ||
		after.ota_financial_summary?.clientTotal !== null ||
		after.ota_financial_summary?.netAfterExpenses !== null ||
		after.ota_financial_summary?.netAfterOtaExpenses !== null ||
		after.ota_financial_summary?.otaExpenseTotal !== null ||
		after.ota_financial_summary?.platformProfit !== null ||
		after.supplierData?.otaAmountSar !== null ||
		after.supplierData?.otaTotalPayoutSar !== null ||
		after.supplierData?.otaExpenseTotalSar !== null ||
		after.supplierData?.otaPlatformMarginSar !== null ||
		Number(after.commission) !== 0 ||
		after.commission_ota !== null ||
		after.supplierData?.otaCommissionSar !== null
	) {
		fail("The expected repair still exposes a false canonical commercial amount.");
	}
	const unsafeConversionValues = [
		after.adminPricing?.sourceExchangeRateToSar,
		after.adminPricing?.exchangeRateToSar,
		after.ota_financial_summary?.sourceExchangeRateToSar,
		after.ota_financial_summary?.exchangeRateToSar,
		after.supplierData?.otaExchangeRateToSar,
		after.supplierData?.otaSourceExchangeRateToSar,
		after.supplierData?.otaPaymentSummary?.exchangeRateToSar,
	];
	if (
		unsafeConversionValues.some((value) => value !== null) ||
		after.adminPricing?.defaultDeductionRate !== null ||
		after.adminPricing?.defaultDeductionApplied !== false ||
		after.supplierData?.otaPaymentSummary?.propertyConversionVerified !== false ||
		after.supplierData?.otaPaymentSummary?.totalGuestPaymentAmount !== null ||
		after.supplierData?.otaPaymentSummary?.totalPayoutAmount !== null ||
		after.supplierData?.otaSourceAmount !== TARGET.portalGuestGross ||
		after.supplierData?.otaSourceCurrency !== TARGET.sourceCurrency
	) {
		fail("The expected repair retained an unsafe fallback conversion or estimated deduction.");
	}
	for (const { day } of flattenDays(after.pickedRoomsPricing)) {
		if (COMMERCIAL_DAY_FIELDS.some((field) => day?.[field] !== null)) {
			fail("A repaired nightly canonical commercial field is not null.");
		}
	}
	for (const room of after.pickedRoomsPricing || []) {
		if (COMMERCIAL_ROOM_FIELDS.some((field) => room?.[field] !== null)) {
			fail("A repaired room canonical commercial field is not null.");
		}
	}
	const contract = after.supplierData.otaCommercialEvidence;
	if (
		contract.roles.guestGross.sourceAmount !== TARGET.portalGuestGross ||
		contract.roles.guestGross.sourceCurrency !== TARGET.sourceCurrency ||
		contract.roles.guestGross.propertyAmount !== null ||
		contract.roles.hotelBase.propertyAmount !== TARGET.rootTotal ||
		contract.roles.explicitOtaCommission.verified !== false ||
		contract.roles.explicitOtaCommission.sourceAmount !== null ||
		contract.roles.hotelPayout.sourceAmount !== payout ||
		contract.roles.hotelPayout.propertyAmount !== null ||
		contract.currencyConversion !== null
	) {
		fail("The repaired source/property commercial roles do not match the exact proof.");
	}
	if (
		contract.provenance?.primary?.sourceId !== selected.jobId ||
		after.supplierData?.otaCommercialRepair?.sourceJobId !== selected.jobId ||
		after.supplierData?.otaCommercialRepair?.sourceJobNumber !==
			selected.jobNumber ||
		after.supplierData?.otaPaymentSummary?.sourceJobId !== selected.jobId ||
		after.supplierData?.otaPaymentSummary?.sourceJobNumber !== selected.jobNumber
	) {
		fail("The repaired evidence does not retain the explicitly selected portal job identity.");
	}
	if (
		canonicalEjsonSha256(commercialProtectedSnapshot(before)) !==
		canonicalEjsonSha256(commercialProtectedSnapshot(after))
	) {
		fail("The repair changes a protected lifecycle, identity, guest, stay, room, root, or payment fact.");
	}
	if (!canonicalEqual(after.pickedRoomsType, after.pickedRoomsPricing)) {
		fail("The repaired room pricing projections diverged.");
	}
	const audits = (after.reservationAuditLog || []).filter(
		(entry) => clean(entry?.repairId) === REPAIR_ID
	);
	if (audits.length !== 1 || Number(audits[0]?.vendorApiCalls) !== 0) {
		fail("The repaired reservation lacks one exact zero-vendor-call repair audit.");
	}
	return true;
}

const primaryReadOptions = () => ({
	readPreference: "primary",
	readConcern: { level: "majority" },
});
const majorityWriteOptions = () => ({ writeConcern: { w: "majority" } });

async function findMany(collection, filter, limit = 3) {
	return collection.find(filter, primaryReadOptions()).limit(limit).toArray();
}

function reservationProviderLookup() {
	return {
		hotelId: objectId(TARGET.hotelId),
		$or: [
			{ reservation_id: TARGET.otaBookingId },
			{ "customer_details.confirmation_number2": TARGET.otaBookingId },
			{ otaIdentityKey: TARGET.otaIdentityKey },
			{ otaCrossTransportIdentityKey: TARGET.otaIdentityKey },
			{ "supplierData.otaConfirmationNumber": TARGET.otaBookingId },
			{ "supplierData.platformConfirmationNumber": TARGET.otaBookingId },
			{ "supplierData.hotelRunner.providerNumber": TARGET.otaBookingId },
		],
	};
}

async function loadRawScope(
	db,
	portalSelection = DEFAULT_PORTAL_SELECTION
) {
	const selected = normalizePortalSelection(portalSelection);
	const reservationCollection = db.collection(COLLECTIONS.reservation);
	const [byId, pmsMatches, providerMatches, event, mirror, job] = await Promise.all([
		reservationCollection.findOne(
			{ _id: objectId(TARGET.reservationMongoId) },
			primaryReadOptions()
		),
		findMany(
			reservationCollection,
			{
				hotelId: objectId(TARGET.hotelId),
				confirmation_number: TARGET.pmsConfirmationNumber,
			},
			3
		),
		findMany(reservationCollection, reservationProviderLookup(), 3),
		db.collection(COLLECTIONS.event).findOne(
			{ _id: objectId(TARGET.eventId) },
			primaryReadOptions()
		),
		db.collection(COLLECTIONS.mirror).findOne(
			{ _id: objectId(TARGET.mirrorId) },
			primaryReadOptions()
		),
		db.collection(COLLECTIONS.portalJob).findOne(
			{ _id: objectId(selected.jobId) },
			primaryReadOptions()
		),
	]);
	if (!byId || pmsMatches.length !== 1 || providerMatches.length !== 1) {
		fail(
			`Exact uniqueness failed (id=${byId ? 1 : 0}, pms=${pmsMatches.length}, provider=${providerMatches.length}).`
		);
	}
	if (
		clean(pmsMatches[0]?._id) !== TARGET.reservationMongoId ||
		clean(providerMatches[0]?._id) !== TARGET.reservationMongoId
	) {
		fail("PMS and Expedia identities do not converge on the same Mongo reservation.");
	}
	assertReservationIdentity(byId);
	assertHotelRunnerEnvelope(event, mirror);
	assertPortalJob(job, selected);
	return { reservation: byId, event, mirror, job };
}

function immutableScope(scope, portalSelection = DEFAULT_PORTAL_SELECTION) {
	const selected = normalizePortalSelection(portalSelection);
	return {
		reservationMongoId: TARGET.reservationMongoId,
		reservationHash: canonicalEjsonSha256(scope.reservation),
		eventId: TARGET.eventId,
		eventHash: canonicalEjsonSha256(scope.event),
		eventPayloadHash: TARGET.eventPayloadHash,
		eventCanonicalHash: TARGET.eventCanonicalHash,
		mirrorId: TARGET.mirrorId,
		mirrorHash: canonicalEjsonSha256(scope.mirror),
		portalJobId: selected.jobId,
		portalJobNumber: selected.jobNumber,
		portalJobHash: canonicalEjsonSha256(scope.job),
	};
}

function repairProofToken(plan) {
	return `${new Date(plan.plannedAt).getTime()}.${plan.planHash}`;
}

function isRepairMarker(reservation) {
	return clean(reservation?.supplierData?.otaCommercialRepair?.repairId) === REPAIR_ID;
}

async function loadPlan({
	db,
	releaseSha,
	plannedAt,
	portalSelection = DEFAULT_PORTAL_SELECTION,
}) {
	const selected = normalizePortalSelection(portalSelection);
	const scope = await loadRawScope(db, selected);
	if (isRepairMarker(scope.reservation)) {
		const backup = await loadAndVerifyBackup(db, selected);
		const reservationRecord = backup.byRole.get("reservation_before");
		if (!reservationRecord) fail("The applied reservation backup is missing.");
		if (canonicalEjsonSha256(scope.reservation) !== reservationRecord.expectedRepairedHash) {
			fail("The marked reservation no longer equals the exact expected repaired EJSON.");
		}
		const evidence = buildCommercialEvidence({
			reservation: reservationRecord.originalDocument,
			event: scope.event,
			job: scope.job,
			portalSelection: selected,
		}).evidence;
		assertPostconditions({
			before: reservationRecord.originalDocument,
			after: scope.reservation,
			evidence,
			payout: evidence.roles.hotelPayout.sourceAmount,
			portalSelection: selected,
		});
		return {
			state: "already_applied",
			repairId: REPAIR_ID,
			releaseSha: lower(releaseSha),
			plannedAt: new Date(plannedAt),
			scope,
			evidence,
			originalHash: reservationRecord.originalHash,
			expectedHash: reservationRecord.expectedRepairedHash,
			backup,
			portalSelection: selected,
			sourceJobHash: backup.byRole.get("expedia_portal_job_evidence")
				.originalHash,
			planHash: backup.manifest.planHash,
		};
	}
	assertPreRepairCommercialState(scope.reservation);
	const built = buildExpectedDocument({
		reservation: scope.reservation,
		event: scope.event,
		job: scope.job,
		releaseSha,
		repairAt: plannedAt,
		portalSelection: selected,
	});
	const originalHash = canonicalEjsonSha256(scope.reservation);
	const expectedHash = canonicalEjsonSha256(built.expectedDocument);
	const protectedHash = canonicalEjsonSha256(
		commercialProtectedSnapshot(scope.reservation)
	);
	const immutable = immutableScope(scope, selected);
	const proofBasis = {
		version: 1,
		repairId: REPAIR_ID,
		releaseSha: lower(releaseSha),
		plannedAt: new Date(plannedAt).toISOString(),
		target: TARGET,
		originalHash,
		expectedHash,
		protectedHash,
		evidenceHash: built.evidence.evidenceHash,
		immutable,
		vendorApiCalls: 0,
		portalSelection: selected,
	};
	return {
		state: "ready",
		repairId: REPAIR_ID,
		releaseSha: lower(releaseSha),
		plannedAt: new Date(plannedAt),
		scope,
		immutable,
		originalDocument: cloneBson(scope.reservation),
		expectedDocument: built.expectedDocument,
		originalHash,
		expectedHash,
		protectedHash,
		evidence: built.evidence,
		sourceJobHash: built.sourceJobHash,
		payout: built.payout,
		portalSelection: selected,
		planHash: canonicalEjsonSha256(proofBasis),
	};
}

function backupRecord({ role, collection, document, expectedRepairedHash = "", capturedAt }) {
	const originalDocument = cloneBson(document);
	const originalEjson = canonicalEjsonString(originalDocument);
	const originalHash = canonicalEjsonSha256(originalDocument);
	const base = {
		_id: `${REPAIR_ID}:${role}`,
		repairId: REPAIR_ID,
		role,
		sourceCollection: collection,
		documentId: clean(document?._id),
		capturedAt: new Date(capturedAt),
		originalHash,
		originalEjsonSha256: sha256(originalEjson),
		originalEjson,
		originalDocument,
		expectedRepairedHash,
	};
	return { ...base, recordHash: canonicalEjsonSha256(base) };
}

function buildBackupRecords(plan) {
	if (plan.state !== "ready") fail("Only a ready plan can create a pre-repair backup.");
	return [
		backupRecord({
			role: "reservation_before",
			collection: COLLECTIONS.reservation,
			document: plan.originalDocument,
			expectedRepairedHash: plan.expectedHash,
			capturedAt: plan.plannedAt,
		}),
		backupRecord({
			role: "hotelrunner_event_evidence",
			collection: COLLECTIONS.event,
			document: plan.scope.event,
			capturedAt: plan.plannedAt,
		}),
		backupRecord({
			role: "hotelrunner_mirror_evidence",
			collection: COLLECTIONS.mirror,
			document: plan.scope.mirror,
			capturedAt: plan.plannedAt,
		}),
		backupRecord({
			role: "expedia_portal_job_evidence",
			collection: COLLECTIONS.portalJob,
			document: plan.scope.job,
			capturedAt: plan.plannedAt,
		}),
	];
}

function verifyBackupRecords(records, manifest = null) {
	if (!Array.isArray(records) || records.length !== 4) {
		fail("The permanent backup must contain exactly four full EJSON/BSON records.");
	}
	const byRole = new Map();
	for (const record of records) {
		if (clean(record?.repairId) !== REPAIR_ID || byRole.has(record?.role)) {
			fail("The permanent backup contains a foreign or duplicate record.");
		}
		const base = { ...record };
		delete base.recordHash;
		if (
			canonicalEjsonSha256(base) !== record.recordHash ||
			canonicalEjsonSha256(record.originalDocument) !== record.originalHash ||
			canonicalEjsonString(record.originalDocument) !== record.originalEjson ||
			sha256(record.originalEjson) !== record.originalEjsonSha256
		) {
			fail(`Permanent backup integrity failed for ${clean(record?.role)}.`);
		}
		byRole.set(record.role, record);
	}
	for (const role of [
		"reservation_before",
		"hotelrunner_event_evidence",
		"hotelrunner_mirror_evidence",
		"expedia_portal_job_evidence",
	]) {
		if (!byRole.has(role)) fail(`Permanent backup role ${role} is missing.`);
	}
	const backupSetSha256 = canonicalEjsonSha256(
		[...byRole.values()]
			.map((record) => ({ id: record._id, recordHash: record.recordHash }))
			.sort((left, right) => left.id.localeCompare(right.id))
	);
	if (manifest) {
		const portalRecord = byRole.get("expedia_portal_job_evidence");
		if (
			clean(manifest?._id) !== REPAIR_ID ||
			manifest?.backupCollection !== BACKUP_COLLECTION ||
			Number(manifest?.backupRecordCount) !== 4 ||
			manifest?.backupSetSha256 !== backupSetSha256 ||
			clean(manifest?.portalJobId) !== clean(portalRecord?.documentId) ||
			clean(manifest?.portalJobHash) !== clean(portalRecord?.originalHash) ||
			clean(portalRecord?.originalDocument?._id) !==
				clean(manifest?.portalJobId) ||
			clean(portalRecord?.originalDocument?.jobNumber) !==
				clean(manifest?.portalJobNumber)
		) {
			fail("The repair manifest no longer binds the exact permanent backup set.");
		}
		for (const record of records) {
			if (manifest?.backupRecordHashes?.[record.role] !== record.recordHash) {
				fail(`The manifest hash for ${record.role} changed.`);
			}
		}
	}
	return { byRole, backupSetSha256 };
}

async function readBackupRecords(db) {
	const collection = db.collection(BACKUP_COLLECTION);
	const records = [];
	for (const role of [
		"reservation_before",
		"hotelrunner_event_evidence",
		"hotelrunner_mirror_evidence",
		"expedia_portal_job_evidence",
	]) {
		const record = await collection.findOne(
			{ _id: `${REPAIR_ID}:${role}` },
			primaryReadOptions()
		);
		if (record) records.push(record);
	}
	return records;
}

async function loadAndVerifyBackup(
	db,
	portalSelection = DEFAULT_PORTAL_SELECTION
) {
	const selected = normalizePortalSelection(portalSelection);
	const manifest = await db
		.collection(MANIFEST_COLLECTION)
		.findOne({ _id: REPAIR_ID }, primaryReadOptions());
	if (!manifest) fail("The permanent repair manifest does not exist.");
	if (
		clean(manifest?.portalJobId) !== selected.jobId ||
		clean(manifest?.portalJobNumber) !== selected.jobNumber
	) {
		fail(
			"The permanent repair manifest is bound to a different selected portal job.",
			"EXPEDIA_REPAIR_PORTAL_SELECTION_MISMATCH"
		);
	}
	const records = await readBackupRecords(db);
	const verified = verifyBackupRecords(records, manifest);
	return { manifest, records, ...verified };
}

async function ensureBackup(db, plan) {
	const selected = normalizePortalSelection(plan.portalSelection);
	const records = buildBackupRecords(plan);
	const verified = verifyBackupRecords(records);
	const backupRecordHashes = Object.fromEntries(
		records.map((record) => [record.role, record.recordHash])
	);
	const manifestDocument = {
		_id: REPAIR_ID,
		repairId: REPAIR_ID,
		state: "backing_up",
		releaseSha: plan.releaseSha,
		planHash: plan.planHash,
		proofPlannedAt: new Date(plan.plannedAt),
		reservationMongoId: TARGET.reservationMongoId,
		originalHash: plan.originalHash,
		expectedRepairedHash: plan.expectedHash,
		evidenceHash: plan.evidence.evidenceHash,
		backupCollection: BACKUP_COLLECTION,
		backupRecordCount: records.length,
		backupRecordHashes,
		backupSetSha256: verified.backupSetSha256,
		portalJobId: selected.jobId,
		portalJobNumber: selected.jobNumber,
		portalJobHash: plan.sourceJobHash,
		vendorApiCalls: 0,
		createdAt: new Date(plan.plannedAt),
	};
	const manifestCollection = db.collection(MANIFEST_COLLECTION);
	let existing = await manifestCollection.findOne(
		{ _id: REPAIR_ID },
		primaryReadOptions()
	);
	if (!existing) {
		try {
			await manifestCollection.insertOne(cloneBson(manifestDocument), majorityWriteOptions());
			existing = manifestDocument;
		} catch (_error) {
			existing = await manifestCollection.findOne(
				{ _id: REPAIR_ID },
				primaryReadOptions()
			);
		}
	}
	if (
		!existing ||
		existing.releaseSha !== plan.releaseSha ||
		existing.planHash !== plan.planHash ||
		existing.originalHash !== plan.originalHash ||
		existing.expectedRepairedHash !== plan.expectedHash ||
		existing.backupSetSha256 !== verified.backupSetSha256 ||
		clean(existing.portalJobId) !== selected.jobId ||
		clean(existing.portalJobNumber) !== selected.jobNumber ||
		clean(existing.portalJobHash) !== plan.sourceJobHash ||
		!["backing_up", "backed_up", "applied"].includes(existing.state)
	) {
		fail("An existing repair manifest conflicts with this exact dry-run proof.");
	}
	const backupCollection = db.collection(BACKUP_COLLECTION);
	for (const record of records) {
		const saved = await backupCollection.findOne({ _id: record._id }, primaryReadOptions());
		if (!saved) {
			try {
				await backupCollection.insertOne(cloneBson(record), majorityWriteOptions());
			} catch (_error) {
				const raced = await backupCollection.findOne(
					{ _id: record._id },
					primaryReadOptions()
				);
				if (!raced || raced.recordHash !== record.recordHash) {
					fail(`Could not persist exact backup ${record.role}.`);
				}
			}
		} else if (saved.recordHash !== record.recordHash) {
			fail(`Existing permanent backup ${record.role} conflicts with the plan.`);
		}
	}
	const readback = await readBackupRecords(db);
	verifyBackupRecords(readback, manifestDocument);
	if (existing.state === "backing_up") {
		const result = await manifestCollection.updateOne(
			{
				_id: REPAIR_ID,
				state: "backing_up",
				planHash: plan.planHash,
				backupSetSha256: verified.backupSetSha256,
			},
			{
				$set: {
					state: "backed_up",
					backupVerifiedAt: new Date(),
				},
			},
			majorityWriteOptions()
		);
		if (Number(result?.matchedCount ?? result?.n ?? 0) !== 1) {
			fail("The manifest changed while finalizing the verified permanent backup.");
		}
	}
	return loadAndVerifyBackup(db, selected);
}

async function verifyImmutableEvidenceAgainstBackup(db, backup) {
	for (const [role, collection] of [
		["hotelrunner_event_evidence", COLLECTIONS.event],
		["hotelrunner_mirror_evidence", COLLECTIONS.mirror],
		["expedia_portal_job_evidence", COLLECTIONS.portalJob],
	]) {
		const record = backup.byRole.get(role);
		const current = await db
			.collection(collection)
			.findOne({ _id: objectId(record.documentId) }, primaryReadOptions());
		if (!current || canonicalEjsonSha256(current) !== record.originalHash) {
			fail(`${role} changed after the full pre-repair backup.`);
		}
	}
}

async function replaceWithHashReadback({ collection, before, after, beforeHash, afterHash }) {
	let acknowledgementError = null;
	try {
		const result = await collection.replaceOne(
			buildExactCasFilter(before),
			cloneBson(after),
			majorityWriteOptions()
		);
		const matched = Number(result?.matchedCount ?? result?.n ?? 0);
		const modified = Number(result?.modifiedCount ?? result?.nModified ?? 0);
		if (result?.acknowledged === false || matched !== 1 || modified !== 1) {
			throw new Error("The exact full-document CAS did not replace one reservation.");
		}
	} catch (error) {
		acknowledgementError = error;
	}
	const observed = await collection.findOne(
		{ _id: objectId(TARGET.reservationMongoId) },
		primaryReadOptions()
	);
	const observedHash = observed ? canonicalEjsonSha256(observed) : "";
	if (observedHash === afterHash) {
		return { document: observed, acknowledgementLost: Boolean(acknowledgementError) };
	}
	if (observedHash === beforeHash) {
		fail(
			`The exact full-document CAS did not commit${
				acknowledgementError ? `: ${acknowledgementError.message}` : "."
			}`,
			"EXPEDIA_REPAIR_CAS_REJECTED"
		);
	}
	fail(
		"The live reservation is neither the exact before nor exact after EJSON; manual intervention is required.",
		"EXPEDIA_REPAIR_MANUAL_INTERVENTION_REQUIRED"
	);
}

async function finalizeAppliedManifest(db, plan, backup) {
	const collection = db.collection(MANIFEST_COLLECTION);
	const result = await collection.updateOne(
		{
			_id: REPAIR_ID,
			state: { $in: ["backed_up", "backing_up"] },
			planHash: plan.planHash,
			backupSetSha256: backup.backupSetSha256,
			portalJobId: plan.portalSelection.jobId,
			portalJobNumber: plan.portalSelection.jobNumber,
			portalJobHash: plan.sourceJobHash,
		},
		{
			$set: {
				state: "applied",
				appliedAt: new Date(),
				appliedDocumentHash: plan.expectedHash,
				vendorApiCalls: 0,
			},
		},
		majorityWriteOptions()
	);
	if (Number(result?.matchedCount ?? result?.n ?? 0) !== 1) {
		const observed = await collection.findOne({ _id: REPAIR_ID }, primaryReadOptions());
		if (
			observed?.state !== "applied" ||
			observed?.appliedDocumentHash !== plan.expectedHash
		) {
			fail("The reservation was repaired but the permanent manifest transition is unresolved.");
		}
	}
}

async function applyRepairPlan({ db, plan }) {
	if (plan.state === "already_applied") {
		return {
			state: "already_applied",
			changed: 0,
			backupSetSha256: plan.backup.backupSetSha256,
			vendorApiCalls: 0,
		};
	}
	if (plan.state !== "ready") fail("Only an exact ready plan can be applied.");
	const backup = await ensureBackup(db, plan);
	await verifyImmutableEvidenceAgainstBackup(db, backup);
	const reservationRecord = backup.byRole.get("reservation_before");
	if (
		reservationRecord.originalHash !== plan.originalHash ||
		reservationRecord.expectedRepairedHash !== plan.expectedHash
	) {
		fail("The permanent reservation backup does not match the approved plan.");
	}
	const current = await db
		.collection(COLLECTIONS.reservation)
		.findOne({ _id: objectId(TARGET.reservationMongoId) }, primaryReadOptions());
	if (!current || canonicalEjsonSha256(current) !== plan.originalHash) {
		fail("The live reservation changed after dry run/backup; no repair write is allowed.");
	}
	const replacement = await replaceWithHashReadback({
		collection: db.collection(COLLECTIONS.reservation),
		before: plan.originalDocument,
		after: plan.expectedDocument,
		beforeHash: plan.originalHash,
		afterHash: plan.expectedHash,
	});
	assertPostconditions({
		before: plan.originalDocument,
		after: replacement.document,
		evidence: plan.evidence,
		payout: plan.payout,
		portalSelection: plan.portalSelection,
	});
	await verifyImmutableEvidenceAgainstBackup(db, backup);
	const verifiedScope = await loadRawScope(db, plan.portalSelection);
	if (canonicalEjsonSha256(verifiedScope.reservation) !== plan.expectedHash) {
		fail("Post-write readback does not equal the exact planned EJSON.");
	}
	await finalizeAppliedManifest(db, plan, backup);
	return {
		state: "applied",
		changed: 1,
		acknowledgementLost: replacement.acknowledgementLost,
		backupSetSha256: backup.backupSetSha256,
		vendorApiCalls: 0,
	};
}

function rollbackProofToken(plan) {
	return `${new Date(plan.plannedAt).getTime()}.${plan.planHash}`;
}

async function loadRollbackPlan({
	db,
	releaseSha,
	plannedAt,
	portalSelection = DEFAULT_PORTAL_SELECTION,
}) {
	const selected = normalizePortalSelection(portalSelection);
	const backup = await loadAndVerifyBackup(db, selected);
	await verifyImmutableEvidenceAgainstBackup(db, backup);
	const reservationRecord = backup.byRole.get("reservation_before");
	const current = await db
		.collection(COLLECTIONS.reservation)
		.findOne({ _id: objectId(TARGET.reservationMongoId) }, primaryReadOptions());
	if (!current) fail("The exact reservation is missing; rollback is blocked.");
	const currentHash = canonicalEjsonSha256(current);
	let state = "";
	if (currentHash === reservationRecord.originalHash) state = "already_rolled_back";
	else if (currentHash === reservationRecord.expectedRepairedHash) state = "ready";
	else {
		fail("Rollback is blocked because the reservation is neither exact repaired nor exact original EJSON.");
	}
	if (state === "ready" && !isRepairMarker(current)) {
		fail("Rollback is blocked because the exact repair marker is missing.");
	}
	const proofBasis = {
		version: 1,
		action: "rollback",
		repairId: REPAIR_ID,
		releaseSha: lower(releaseSha),
		plannedAt: new Date(plannedAt).toISOString(),
		originalHash: reservationRecord.originalHash,
		expectedRepairedHash: reservationRecord.expectedRepairedHash,
		backupSetSha256: backup.backupSetSha256,
		immutableEvidenceHashes: {
			event: backup.byRole.get("hotelrunner_event_evidence").originalHash,
			mirror: backup.byRole.get("hotelrunner_mirror_evidence").originalHash,
			portalJob: backup.byRole.get("expedia_portal_job_evidence").originalHash,
		},
		vendorApiCalls: 0,
		portalSelection: selected,
	};
	return {
		state,
		action: "rollback",
		repairId: REPAIR_ID,
		releaseSha: lower(releaseSha),
		plannedAt: new Date(plannedAt),
		planHash: canonicalEjsonSha256(proofBasis),
		backup,
		currentDocument: current,
		originalDocument: reservationRecord.originalDocument,
		originalHash: reservationRecord.originalHash,
		expectedHash: reservationRecord.expectedRepairedHash,
		portalSelection: selected,
	};
}

async function applyRollbackPlan({ db, plan }) {
	if (plan.state === "already_rolled_back") {
		return { state: "already_rolled_back", changed: 0, vendorApiCalls: 0 };
	}
	if (plan.state !== "ready") fail("Only an exact ready rollback plan can be applied.");
	await verifyImmutableEvidenceAgainstBackup(db, plan.backup);
	const replacement = await replaceWithHashReadback({
		collection: db.collection(COLLECTIONS.reservation),
		before: plan.currentDocument,
		after: plan.originalDocument,
		beforeHash: plan.expectedHash,
		afterHash: plan.originalHash,
	});
	assertReservationIdentity(replacement.document);
	assertPreRepairCommercialState(replacement.document);
	await verifyImmutableEvidenceAgainstBackup(db, plan.backup);
	const result = await db.collection(MANIFEST_COLLECTION).updateOne(
		{
			_id: REPAIR_ID,
			state: { $in: ["applied", "backed_up"] },
			backupSetSha256: plan.backup.backupSetSha256,
			portalJobId: plan.portalSelection.jobId,
			portalJobNumber: plan.portalSelection.jobNumber,
		},
		{
			$set: {
				state: "rolled_back",
				rolledBackAt: new Date(),
				rolledBackReleaseSha: plan.releaseSha,
				rollbackDocumentHash: plan.originalHash,
				vendorApiCalls: 0,
			},
		},
		majorityWriteOptions()
	);
	if (Number(result?.matchedCount ?? result?.n ?? 0) !== 1) {
		const manifest = await db
			.collection(MANIFEST_COLLECTION)
			.findOne({ _id: REPAIR_ID }, primaryReadOptions());
		if (
			manifest?.state !== "rolled_back" ||
			manifest?.rollbackDocumentHash !== plan.originalHash
		) {
			fail("Rollback restored the reservation but its manifest transition is unresolved.");
		}
	}
	return {
		state: "rolled_back",
		changed: 1,
		acknowledgementLost: replacement.acknowledgementLost,
		backupSetSha256: plan.backup.backupSetSha256,
		vendorApiCalls: 0,
	};
}

function sanitizedForwardOutput(plan, mode, proof = "") {
	const gross = plan.evidence?.roles?.guestGross;
	const payout = plan.evidence?.roles?.hotelPayout;
	return {
		mode,
		repairId: REPAIR_ID,
		releaseSha: plan.releaseSha,
		state: plan.state,
		proof: mode === "dry_run" && plan.state === "ready" ? proof : undefined,
		proofExpiresInMinutes:
			mode === "dry_run" && plan.state === "ready"
				? PROOF_MAX_AGE_MS / 60_000
				: undefined,
		planHash: plan.planHash,
		reservationCountByPms: 1,
		reservationCountByExpediaNumber: 1,
		reservationMongoId: TARGET.reservationMongoId,
		pmsConfirmationNumber: TARGET.pmsConfirmationNumber,
		expediaConfirmationNumber: TARGET.otaBookingId,
		hotelRunnerEventId: TARGET.eventId,
		hotelRunnerMirrorId: TARGET.mirrorId,
		portalSourceJobId: plan.portalSelection?.jobId,
		portalSourceJobNumber: plan.portalSelection?.jobNumber,
		portalSourceJobHash: plan.sourceJobHash || plan.immutable?.portalJobHash,
		commercialEvidenceHash: plan.evidence?.evidenceHash,
		commercial: {
			guestGrossSourceAmount: gross?.sourceAmount,
			guestGrossSourceCurrency: gross?.sourceCurrency,
			guestGrossPropertyAmount: gross?.propertyAmount,
			hotelBasePropertyAmount: TARGET.rootTotal,
			hotelBasePropertyCurrency: TARGET.propertyCurrency,
			hotelPayoutSourceAmount: payout?.sourceAmount,
			hotelPayoutSourceCurrency: payout?.sourceCurrency,
			hotelPayoutPropertyAmount: payout?.propertyAmount,
			deductionSourceAmount:
				plan.evidence?.roles?.deductionAggregate?.sourceAmount,
			explicitOtaCommission: null,
			pmsCommission: 0,
			trustedCurrencyConversion: false,
			canonicalClientNetDeductionAndMargin: null,
		},
		backupCollection: BACKUP_COLLECTION,
		backupSetSha256: plan.backup?.backupSetSha256,
		createsReservations: false,
		mutatesLifecycleGuestStayRoomAssignmentPaymentVccSettlementOrRoot: false,
		mutatesHotelRunnerEventMirrorOrPortalJob: false,
		vendorApiCalls: 0,
	};
}

function sanitizedRollbackOutput(plan, mode, proof = "") {
	return {
		mode,
		action: "rollback",
		repairId: REPAIR_ID,
		releaseSha: plan.releaseSha,
		state: plan.state,
		proof: mode === "rollback_dry_run" && plan.state === "ready" ? proof : undefined,
		proofExpiresInMinutes:
			mode === "rollback_dry_run" && plan.state === "ready"
				? PROOF_MAX_AGE_MS / 60_000
				: undefined,
		planHash: plan.planHash,
		reservationMongoId: TARGET.reservationMongoId,
		fromHash: plan.expectedHash,
		toBackupHash: plan.originalHash,
		backupCollection: BACKUP_COLLECTION,
		backupSetSha256: plan.backup.backupSetSha256,
		portalSourceJobId: plan.portalSelection?.jobId,
		portalSourceJobNumber: plan.portalSelection?.jobNumber,
		fullDocumentCas: true,
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
	return mongoose.connection.db;
}

async function assertWritablePrimary(db) {
	const admin = typeof db?.admin === "function" ? db.admin() : null;
	if (!admin || typeof admin.command !== "function") {
		fail("MongoDB topology could not be inspected before apply.", "EXPEDIA_REPAIR_TOPOLOGY_UNKNOWN");
	}
	const hello = await admin.command({ hello: 1 });
	if (hello?.isWritablePrimary !== true && hello?.ismaster !== true) {
		fail("Apply requires the writable MongoDB primary.", "EXPEDIA_REPAIR_PRIMARY_REQUIRED");
	}
	return true;
}

async function main(
	argv = process.argv.slice(2),
	{
		clock = () => new Date(),
		connect = connectDatabase,
		disconnect = async () => mongoose.disconnect(),
		resolveReleaseSha = currentReleaseSha,
		db: injectedDb = null,
	} = {}
) {
	const options = parseArguments(argv);
	const portalSelection = portalSelectionFromArguments(options);
	assertRelease(options.releaseSha, resolveReleaseSha());
	const now = clock();
	const proofDetails = options.apply ? parseProof(options.proof, now) : null;
	const plannedAt = proofDetails?.plannedAt || now;
	const database =
		process.env.DATABASE || process.env.MONGO_URI || process.env.MONGODB_URI;
	if (!database && !injectedDb) fail("Missing DATABASE/MONGO connection string.");
	let db = injectedDb;
	let connectedHere = false;
	try {
		if (!db) {
			db = await connect(database);
			connectedHere = true;
		}
		if (options.rollback) {
			const plan = await loadRollbackPlan({
				db,
				releaseSha: options.releaseSha,
				plannedAt,
				portalSelection,
			});
			const generatedProof = rollbackProofToken(plan);
			if (
				options.apply &&
				(proofDetails.planHash !== plan.planHash || options.proof !== generatedProof)
			) {
				fail("The exact rollback scope no longer matches the supplied proof.", "EXPEDIA_REPAIR_PROOF_MISMATCH");
			}
			console.log(
				JSON.stringify(
					sanitizedRollbackOutput(
						plan,
						options.apply ? "rollback_apply" : "rollback_dry_run",
						generatedProof
					),
					null,
					2
				)
			);
			if (!options.apply) return { state: "rollback_dry_run_ready", plan, proof: generatedProof };
			await assertWritablePrimary(db);
			const result = await applyRollbackPlan({ db, plan });
			console.log(JSON.stringify(result, null, 2));
			return result;
		}
		const plan = await loadPlan({
			db,
			releaseSha: options.releaseSha,
			plannedAt,
			portalSelection,
		});
		if (plan.state === "already_applied") {
			console.log(JSON.stringify(sanitizedForwardOutput(plan, "already_applied"), null, 2));
			return { state: "already_applied", plan, vendorApiCalls: 0 };
		}
		const generatedProof = repairProofToken(plan);
		if (
			options.apply &&
			(proofDetails.planHash !== plan.planHash || options.proof !== generatedProof)
		) {
			fail("The live exact scope no longer matches the supplied dry-run proof.", "EXPEDIA_REPAIR_PROOF_MISMATCH");
		}
		console.log(
			JSON.stringify(
				sanitizedForwardOutput(
					plan,
					options.apply ? "apply" : "dry_run",
					generatedProof
				),
				null,
				2
			)
		);
		if (!options.apply) return { state: "dry_run_ready", plan, proof: generatedProof };
		await assertWritablePrimary(db);
		const result = await applyRepairPlan({ db, plan });
		console.log(JSON.stringify(result, null, 2));
		return result;
	} finally {
		if (connectedHere) await disconnect();
	}
}

if (require.main === module) {
	main().catch((error) => {
		console.error("[expedia-commercial-enrichment-repair] stopped", {
			code: clean(error?.code || "EXPEDIA_COMMERCIAL_REPAIR_FAILED").slice(0, 100),
			message: clean(error?.message || "Unknown repair failure").slice(0, 500),
		});
		process.exitCode = 1;
	});
}

module.exports = {
	BACKUP_COLLECTION,
	COLLECTIONS,
	DEFAULT_PORTAL_SELECTION,
	MANIFEST_COLLECTION,
	PROOF_MAX_AGE_MS,
	REPAIR_ID,
	TARGET,
	applyRepairPlan,
	applyRollbackPlan,
	assertWritablePrimary,
	assertHotelRunnerEnvelope,
	assertPortalJob,
	assertPostconditions,
	assertPreRepairCommercialState,
	assertRelease,
	backupRecord,
	buildBackupRecords,
	buildCommercialEvidence,
	buildExpectedDocument,
	canonicalEjsonString,
	commercialProtectedSnapshot,
	currentReleaseSha,
	explicitPortalPayout,
	loadAndVerifyBackup,
	loadPlan,
	loadRawScope,
	loadRollbackPlan,
	main,
	nullCommercialRooms,
	parseArguments,
	parseProof,
	portalCandidate,
	portalSelectionFromArguments,
	repairProofToken,
	rollbackProofToken,
	sanitizedForwardOutput,
	sanitizedRollbackOutput,
	verifyBackupRecords,
};
