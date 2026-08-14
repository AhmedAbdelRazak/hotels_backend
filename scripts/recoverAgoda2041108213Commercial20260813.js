/** @format */

"use strict";

// Closed-scope recovery for one authenticated direct Agoda archive whose
// lower-authority HotelRunner email relay already created the PMS review row.
// The command is dry-run by default. It never imports a HotelRunner client,
// worker, adapter, controller, route, or configuration module.

require("dotenv").config();

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const https = require("node:https");
const mongoose = require("mongoose");

mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);
mongoose.set("strictQuery", true);

const HotelDetails = require("../models/hotel_details");
const InboundEmail = require("../models/inbound_email");
const Reservations = require("../models/reservations");
const {
	buildHotelRunnerEmailCommercialEvidence,
	buildReservationDocument,
	extractNormalizedReservation,
	hashText,
	reconcileOtaReservation,
	resolveHotel,
	resolveRoomMatch,
} = require("../services/otaReservationMapper");

const POLICY_DATE = "2026-08-13";
const REPAIR_ID = "agoda-2041108213-direct-commercial-refresh-20260813-v1";
const PROOF_MAX_AGE_MS = 30 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 1000;
const HOTELRUNNER_DISABLED_GATES = Object.freeze([
	"HOTELRUNNER_INTEGRATION_ENABLED",
	"HOTELRUNNER_PROJECTION_ENABLED",
	"HOTELRUNNER_PULL_ENABLED",
	"HOTELRUNNER_ROOM_LIST_SYNC_ENABLED",
	"HOTELRUNNER_CONFIRM_DELIVERY_ENABLED",
]);
const FORBIDDEN_HOTELRUNNER_RUNTIME_MODULES = Object.freeze([
	"hotelrunnerClient.js",
	"hotelrunnerReservationAdapter.js",
	"hotelrunnerWorker.js",
	"hotelrunnerSyncWorker.js",
	"hotelrunnerController.js",
	"hotelrunnerConfig.js",
]);

const TARGET = Object.freeze({
	provider: "agoda",
	confirmationNumber: "2041108213",
	pmsConfirmationNumber: "2207032113",
	reservationId: "6a7e6ab079505aeca6507358",
	directAuditId: "6a7e6a7779505aeca6507271",
	relayAuditId: "6a7e6aad79505aeca6507337",
	hotelId: "6a40b6a1a6efe70450536038",
	ownerId: "68b74714fb50e159d48c714d",
	roomConfigId: "6a40df5f1a6d1850eb25c183",
	roomType: "doubleRooms",
	roomDisplayName: "Double Room \u2013 Comfort & Relaxation",
	checkinDate: "2026-08-18",
	checkoutDate: "2026-08-19",
	roomCount: 1,
	rootSar: 75,
	grossSar: 60.76,
	payoutSar: 37.6,
	expenseSar: 23.16,
	platformMarginSar: -37.4,
	otaCommissionSar: 9.11,
	deductionComponentsSar: Object.freeze([9.11, 6.08, 2.28]),
	unclassifiedDeductionSar: 5.69,
	reservationVersion: 0,
	reservationCreatedAt: "2026-08-14T01:09:04.043Z",
	reservationUpdatedAt: "2026-08-14T01:09:04.043Z",
	directAuditVersion: 0,
	directAuditReceivedAt: "2026-08-14T01:08:07.524Z",
	directAuditCreatedAt: "2026-08-14T01:08:07.539Z",
	directAuditUpdatedAt: "2026-08-14T01:08:17.804Z",
	directSourceReceivedAt: "2026-08-14T01:08:02.000Z",
	directEmailHash:
		"70343c8fc4487496f800eb1d5e2b85895b7713f3c553e7a88bc00a9d5c980112",
	directTextHash:
		"45498cb0d859c05c938d046b06bc47952130d4ad030db923dc8db46fc776f7aa",
	directDedupeKey:
		"mid:c70ed34429a2f1c18463b9b011a3c3b72267d932b1027d43eb2dac5fabc07446",
	relayAuditVersion: 0,
	relayEmailHash:
		"e65b8e2da014a70a1cd86161396aaabf157b726e19f2212b640716c17cc90e6d",
	relayTextHash:
		"6754aa7232b8ef581c1bc261302252802e0ddfafa9ba67b6e585ea9094037226",
	relayDedupeKey:
		"mid:4191f293544b2be5661071a54c9c6f463d66cabacc66c4b334dbba6eb915b14b",
	relayLastSourceReceivedAt: "2026-08-14T01:08:59.000Z",
	originalRoomMatchType: "explicit_capacity",
	originalRoomMatchScore: 0.98,
});

class RecoverySafetyError extends Error {
	constructor(code, message) {
		super(message);
		this.name = "RecoverySafetyError";
		this.code = code;
	}
}

const fail = (code, message) => {
	throw new RecoverySafetyError(code, message);
};
const clean = (value) => String(value ?? "").trim();
const lower = (value) => clean(value).toLowerCase();
const id = (value) => lower(value?._id || value);
const dateIso = (value) => {
	const date = value instanceof Date ? value : new Date(value || "");
	return Number.isFinite(date.getTime()) ? date.toISOString() : "";
};
const dateOnly = (value) => dateIso(value).slice(0, 10) || clean(value).slice(0, 10);
const money = (value) => {
	if (value === null || value === undefined || value === "") return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : null;
};
const sha256 = (value) =>
	crypto.createHash("sha256").update(String(value)).digest("hex");

function canonicalize(value) {
	if (value instanceof Date) return value.toISOString();
	if (value && typeof value.toHexString === "function") return lower(value.toHexString());
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, canonicalize(value[key])])
		);
	}
	return value;
}

const hashObject = (value) => sha256(JSON.stringify(canonicalize(value)));
const clone = (value) => JSON.parse(JSON.stringify(value));

function parseArguments(argv = process.argv.slice(2)) {
	const options = { apply: false, repairId: "", proof: "" };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--apply") options.apply = true;
		else if (argument.startsWith("--repair-id=")) {
			options.repairId = clean(argument.slice(12));
		} else if (argument === "--repair-id") {
			options.repairId = clean(argv[++index]);
		} else if (argument.startsWith("--proof=")) {
			options.proof = lower(argument.slice(8));
		} else if (argument === "--proof") {
			options.proof = lower(argv[++index]);
		} else {
			fail("RECOVERY_ARGUMENT_INVALID", `Unknown recovery argument: ${argument}`);
		}
	}
	if (!options.apply && (options.repairId || options.proof)) {
		fail(
			"RECOVERY_DRY_RUN_ARGUMENT",
			"--repair-id and --proof are accepted only together with --apply."
		);
	}
	if (options.apply && options.repairId !== REPAIR_ID) {
		fail(
			"RECOVERY_REPAIR_ID_REQUIRED",
			`--apply requires --repair-id=${REPAIR_ID}.`
		);
	}
	if (options.apply && !/^\d{13}\.[a-f0-9]{64}$/.test(options.proof)) {
		fail(
			"RECOVERY_PROOF_REQUIRED",
			"--apply requires the exact unexpired dry-run proof."
		);
	}
	return options;
}

function parseProof(proof, now = new Date()) {
	const match = lower(proof).match(/^(\d{13})\.([a-f0-9]{64})$/);
	if (!match) fail("RECOVERY_PROOF_INVALID", "Dry-run proof format is invalid.");
	const plannedAt = new Date(Number(match[1]));
	const age = now.getTime() - plannedAt.getTime();
	if (age < -CLOCK_SKEW_MS || age > PROOF_MAX_AGE_MS) {
		fail("RECOVERY_PROOF_EXPIRED", "Dry-run proof is expired or from the future.");
	}
	return { plannedAt, planHash: match[2] };
}

function assertHotelRunnerDisabled(env = process.env) {
	for (const key of HOTELRUNNER_DISABLED_GATES) {
		if (lower(env[key]) !== "false") {
			fail(
				"RECOVERY_HOTELRUNNER_GATE_ENABLED",
				`${key} must be explicitly false for this recovery.`
			);
		}
	}
	return true;
}

function loadedForbiddenHotelRunnerModules(cache = require.cache) {
	return Object.keys(cache || {}).filter((filename) =>
		FORBIDDEN_HOTELRUNNER_RUNTIME_MODULES.some((moduleName) =>
			filename.replace(/\\/g, "/").endsWith(`/${moduleName}`)
		)
	);
}

function assertNoForbiddenHotelRunnerRuntimeModules(cache = require.cache) {
	const forbidden = loadedForbiddenHotelRunnerModules(cache);
	if (forbidden.length) {
		fail(
			"RECOVERY_HOTELRUNNER_RUNTIME_MODULE_LOADED",
			"A HotelRunner runtime/network module is loaded; recovery stopped."
		);
	}
	return true;
}

function stripArchivedSubject(audit = {}) {
	const subject = clean(audit.subject).replace(/\r/g, "");
	const body = String(audit.bodyText || "").replace(/\r/g, "");
	return body.startsWith(`${subject}\n`) ? body.slice(subject.length + 1) : body;
}

function emailFromAudit(audit = {}) {
	const source = audit.normalizedReservation?.source || {};
	return {
		from: audit.from || "",
		to: audit.to || "",
		cc: audit.cc || "",
		bcc: audit.bcc || "",
		subject: audit.subject || "",
		text: stripArchivedSubject(audit),
		html: audit.bodyHtml || "",
		messageId: audit.messageId || "",
		receivedAt: audit.receivedAt,
		deliveryReceivedAt: audit.receivedAt,
		sourceReceivedAt:
			source.receivedAt || source.messageDate || audit.receivedAt,
		sourceTimestampMethod: source.timestampMethod || "",
		senderAuthentication: audit.senderAuthentication || {},
	};
}

function assertDirectArchiveImmutable(
	target,
	audit,
	{ expectedVersion = target.directAuditVersion } = {}
) {
	assert.ok(audit, "Pinned direct Agoda archive is missing.");
	assert.equal(id(audit._id), target.directAuditId, "Direct audit ID changed.");
	assert.equal(Number(audit.__v), expectedVersion, "Direct audit version changed.");
	assert.equal(lower(audit.provider), target.provider, "Direct audit provider changed.");
	assert.equal(clean(audit.confirmationNumber), target.confirmationNumber, "Direct confirmation changed.");
	assert.equal(lower(audit.emailHash), target.directEmailHash, "Direct email hash changed.");
	assert.equal(lower(audit.textHash), target.directTextHash, "Direct text hash changed.");
	assert.equal(hashText(audit.bodyText || ""), target.directTextHash, "Direct body hash changed.");
	assert.equal(clean(audit.dedupeKey), target.directDedupeKey, "Direct dedupe key changed.");
	assert.equal(dateIso(audit.receivedAt), target.directAuditReceivedAt, "Direct receipt time changed.");
	assert.equal(dateIso(audit.createdAt), target.directAuditCreatedAt, "Direct creation time changed.");
	assert.equal(audit.senderAuthentication?.authenticatedAligned, true, "Direct aligned authentication was lost.");
	assert.equal(audit.senderAuthentication?.dkimAlignedPass, true, "Direct aligned DKIM was lost.");
	assert.equal(lower(audit.senderAuthentication?.trustedProvider), target.provider, "Direct trusted provider changed.");
	assert.equal(lower(audit.senderAuthentication?.fromDomain), "agoda.com", "Direct From domain changed.");
	assert.equal(lower(audit.senderAuthentication?.method), "dkim", "Direct authentication method changed.");
	assert.equal(lower(audit.normalizedReservation?.source?.textHash), target.directTextHash, "Stored normalized source hash changed.");
	return true;
}

function assertOriginalDirectAudit(target, audit) {
	assertDirectArchiveImmutable(target, audit);
	assert.equal(dateIso(audit.updatedAt), target.directAuditUpdatedAt, "Direct audit update time changed.");
	assert.equal(lower(audit.processingStatus), "needs_review", "Direct audit no longer needs review.");
	assert.equal(lower(audit.skipReason), "ota_parser_requires_manual_review", "Direct audit skip reason changed.");
	assert.equal(id(audit.reservationMongoId), "", "Direct audit is already linked.");
	assert.notEqual(audit.hasReservationConnection, true, "Direct audit already reports a connection.");
	assert.equal(lower(audit.reconciliation?.repairId), "", "Direct audit already has another recovery marker.");
	return true;
}

function relayTruthSnapshot(target, audit) {
	return {
		id: id(audit?._id),
		version: Number(audit?.__v),
		provider: lower(audit?.provider),
		confirmationNumber: clean(audit?.confirmationNumber),
		emailHash: lower(audit?.emailHash),
		textHash: lower(audit?.textHash),
		dedupeKey: clean(audit?.dedupeKey),
		authenticatedAligned: audit?.senderAuthentication?.authenticatedAligned === true,
		trustedProvider: lower(audit?.senderAuthentication?.trustedProvider),
		processingStatus: lower(audit?.processingStatus),
		automationAction: lower(audit?.automationAction),
		hasReservationConnection: audit?.hasReservationConnection === true,
		reservationMongoId: id(audit?.reservationMongoId),
		pmsConfirmationNumber: clean(audit?.pmsConfirmationNumber),
		hotelId: id(audit?.hotelId),
		updatedAt: dateIso(audit?.updatedAt),
		reconciliation: canonicalize(audit?.reconciliation || {}),
	};
}

function assertRelayTruth(target, audit) {
	assert.ok(audit, "Pinned HotelRunner relay audit is missing.");
	assert.equal(id(audit._id), target.relayAuditId, "Relay audit ID changed.");
	assert.equal(Number(audit.__v), target.relayAuditVersion, "Relay audit version changed.");
	assert.equal(lower(audit.emailHash), target.relayEmailHash, "Relay email hash changed.");
	assert.equal(lower(audit.textHash), target.relayTextHash, "Relay text hash changed.");
	assert.equal(hashText(audit.bodyText || ""), target.relayTextHash, "Relay body hash changed.");
	assert.equal(clean(audit.dedupeKey), target.relayDedupeKey, "Relay dedupe key changed.");
	assert.equal(audit.senderAuthentication?.authenticatedAligned, true, "Relay aligned authentication was lost.");
	assert.equal(lower(audit.senderAuthentication?.trustedProvider), "hotelrunner", "Relay transport provider changed.");
	assert.equal(lower(audit.processingStatus), "created", "Relay processing truth changed.");
	assert.equal(audit.hasReservationConnection, true, "Relay connection truth changed.");
	assert.equal(id(audit.reservationMongoId), target.reservationId, "Relay reservation link changed.");
	assert.equal(clean(audit.pmsConfirmationNumber), target.pmsConfirmationNumber, "Relay PMS link changed.");
	return relayTruthSnapshot(target, audit);
}

function nullCommercialRoomSnapshot(target, row, label) {
	assert.ok(row, `${label} is missing.`);
	assert.equal(id(row.hotelRoomConfigId || row.localRoomConfigId), target.roomConfigId, `${label} room config changed.`);
	assert.equal(clean(row.room_type), target.roomType, `${label} room type changed.`);
	assert.equal(clean(row.displayName), target.roomDisplayName, `${label} room display changed.`);
	assert.equal(Number(row.count), 1, `${label} room count changed.`);
	assert.equal((row.pricingByDay || []).length, 1, `${label} daily row count changed.`);
	const day = row.pricingByDay[0];
	assert.equal(clean(day.date), target.checkinDate, `${label} date changed.`);
	assert.equal(money(day.rootPrice), target.rootSar, `${label} root changed.`);
	assert.equal(money(day.totalPriceWithoutCommission), target.rootSar, `${label} root total changed.`);
	for (const field of [
		"price",
		"clientPrice",
		"mainPrice",
		"totalPriceWithCommission",
		"netAfterExpenses",
		"netAfterOtaExpenses",
		"otaExpenseAmount",
		"platformMargin",
	]) {
		assert.equal(day[field] ?? null, null, `${label}.${field} is no longer null.`);
	}
	return true;
}

function recoveryMarkerMatches(target, reservation = {}) {
	const marker = reservation.supplierData?.directOtaArchiveCommercialRecovery || {};
	return !!(
		lower(marker.repairId) === REPAIR_ID &&
		id(marker.inboundEmailId) === target.directAuditId &&
		lower(marker.provider) === target.provider &&
		clean(marker.confirmationNumber) === target.confirmationNumber &&
		lower(marker.emailHash) === target.directEmailHash &&
		lower(marker.textHash) === target.directTextHash
	);
}

function assertOriginalReservation(target, reservation) {
	assert.ok(reservation, "Pinned Reservation is missing.");
	assert.equal(id(reservation._id), target.reservationId, "Reservation ID changed.");
	assert.equal(Number(reservation.__v), target.reservationVersion, "Reservation version changed.");
	assert.equal(dateIso(reservation.createdAt), target.reservationCreatedAt, "Reservation creation time changed.");
	assert.equal(dateIso(reservation.updatedAt), target.reservationUpdatedAt, "Reservation update time changed.");
	assert.equal(id(reservation.hotelId), target.hotelId, "Reservation hotel changed.");
	assert.equal(id(reservation.belongsTo), target.ownerId, "Reservation owner changed.");
	assert.equal(clean(reservation.reservation_id), target.confirmationNumber, "Reservation OTA identity changed.");
	assert.equal(clean(reservation.confirmation_number), target.pmsConfirmationNumber, "Reservation PMS number changed.");
	assert.equal(lower(reservation.otaIdentityKey), `agoda:${target.confirmationNumber}`, "Reservation identity key changed.");
	assert.equal(lower(reservation.state), "ota platform review", "Reservation state changed.");
	assert.equal(lower(reservation.reservation_status), "ota platform review", "Reservation status changed.");
	assert.equal(dateOnly(reservation.checkin_date), target.checkinDate, "Reservation check-in changed.");
	assert.equal(dateOnly(reservation.checkout_date), target.checkoutDate, "Reservation check-out changed.");
	assert.equal(Number(reservation.total_rooms), 1, "Reservation room count changed.");
	assert.equal(reservation.total_amount ?? null, null, "Reservation gross is no longer null.");
	assert.equal(money(reservation.sub_total), target.rootSar, "Reservation root total changed.");
	assert.equal(clean(reservation.currency).toUpperCase(), "SAR", "Reservation currency changed.");
	assert.equal(reservation.commission_ota ?? null, null, "Reservation OTA commission is no longer null.");
	assert.deepEqual((reservation.roomId || []).map(id), [], "Physical rooms were assigned.");
	assert.deepEqual(reservation.bedNumber || [], [], "Beds were assigned.");
	assert.equal((reservation.pickedRoomsType || []).length, 1, "pickedRoomsType changed.");
	assert.equal((reservation.pickedRoomsPricing || []).length, 1, "pickedRoomsPricing changed.");
	assert.deepEqual(
		canonicalize(reservation.pickedRoomsType),
		canonicalize(reservation.pickedRoomsPricing),
		"The two canonical room arrays diverged."
	);
	nullCommercialRoomSnapshot(target, reservation.pickedRoomsType[0], "pickedRoomsType[0]");
	nullCommercialRoomSnapshot(target, reservation.pickedRoomsPricing[0], "pickedRoomsPricing[0]");
	const pricing = reservation.adminPricing || {};
	assert.equal(lower(pricing.mode).replace(/_/g, " "), "ota platform sync", "Admin pricing mode changed.");
	assert.equal(pricing.clientTotal ?? null, null, "Admin guest gross is no longer null.");
	assert.equal(money(pricing.rootTotal), target.rootSar, "Admin root changed.");
	assert.equal(pricing.netAfterExpensesTotal ?? null, null, "Admin payout is no longer null.");
	assert.equal(pricing.otaExpenseTotal ?? null, null, "Admin OTA expense is no longer null.");
	assert.equal(pricing.platformMarginTotal ?? null, null, "Admin margin is no longer null.");
	assert.equal(lower(pricing.commercialResolution), "unresolved", "Commercial resolution changed.");
	assert.equal(Number(reservation.supplierData?.otaSourceAuthority), 1, "Relay source authority changed.");
	assert.equal(money(reservation.supplierData?.otaSourceAmount), target.payoutSar, "Relay source amount changed.");
	assert.equal(lower(reservation.supplierData?.otaRoomMatchType), target.originalRoomMatchType, "Relay room-match type changed.");
	assert.equal(Number(reservation.supplierData?.otaRoomMatchScore), target.originalRoomMatchScore, "Relay room-match score changed.");
	assert.equal(dateIso(reservation.supplierData?.otaLastSourceReceivedAt), target.relayLastSourceReceivedAt, "Relay source watermark changed.");
	assert.equal(lower(reservation.otaPlatformReview?.status), "pending", "OTA review is no longer pending.");
	assert.equal(Boolean(reservation.otaPlatformReview?.releasedAt), false, "OTA review was released.");
	assert.equal(Boolean(reservation.otaPlatformReview?.closedAt), false, "OTA review was closed.");
	assert.equal(recoveryMarkerMatches(target, reservation), false, "Original Reservation already has the recovery marker.");
	return true;
}

function assertAppliedRoom(target, row, label) {
	assert.ok(row, `${label} is missing.`);
	assert.equal(id(row.hotelRoomConfigId || row.localRoomConfigId), target.roomConfigId, `${label} config changed.`);
	assert.equal(clean(row.room_type), target.roomType, `${label} type changed.`);
	assert.equal(clean(row.displayName), target.roomDisplayName, `${label} display changed.`);
	assert.equal(Number(row.count), 1, `${label} count changed.`);
	assert.equal(money(row.chosenPrice), target.grossSar, `${label} chosen gross changed.`);
	assert.equal(
		money(row.totalPriceWithCommission),
		target.grossSar,
		`${label} room gross total changed.`
	);
	assert.equal(
		money(row.hotelShouldGet),
		target.rootSar,
		`${label} room root total changed.`
	);
	assert.equal((row.pricingByDay || []).length, 1, `${label} day count changed.`);
	const day = row.pricingByDay[0];
	assert.equal(clean(day.date), target.checkinDate, `${label} date changed.`);
	assert.equal(money(day.price), target.grossSar, `${label} price changed.`);
	assert.equal(money(day.clientPrice), target.grossSar, `${label} gross changed.`);
	assert.equal(money(day.mainPrice), target.grossSar, `${label} main gross changed.`);
	assert.equal(
		money(day.totalPriceWithCommission),
		target.grossSar,
		`${label} daily gross total changed.`
	);
	assert.equal(money(day.netAfterExpenses), target.payoutSar, `${label} payout changed.`);
	assert.equal(
		money(day.netAfterOtaExpenses),
		target.payoutSar,
		`${label} OTA-net payout changed.`
	);
	assert.equal(money(day.otaExpenseAmount), target.expenseSar, `${label} expense changed.`);
	assert.equal(money(day.rootPrice), target.rootSar, `${label} root changed.`);
	assert.equal(
		money(day.totalPriceWithoutCommission),
		target.rootSar,
		`${label} daily root total changed.`
	);
	assert.equal(money(day.platformMargin), target.platformMarginSar, `${label} margin changed.`);
	return true;
}

function assertAppliedReservation(target, reservation) {
	assert.ok(reservation, "Recovered Reservation is missing.");
	assert.equal(id(reservation._id), target.reservationId, "Recovered Reservation ID changed.");
	assert.equal(id(reservation.hotelId), target.hotelId, "Recovered hotel changed.");
	assert.equal(id(reservation.belongsTo), target.ownerId, "Recovered owner changed.");
	assert.equal(clean(reservation.reservation_id), target.confirmationNumber, "Recovered OTA identity changed.");
	assert.equal(clean(reservation.confirmation_number), target.pmsConfirmationNumber, "Recovered PMS identity changed.");
	assert.equal(lower(reservation.otaIdentityKey), `agoda:${target.confirmationNumber}`, "Recovered identity key changed.");
	assert.equal(lower(reservation.state), "ota platform review", "Recovered state changed.");
	assert.equal(lower(reservation.reservation_status), "ota platform review", "Recovered status changed.");
	assert.equal(dateOnly(reservation.checkin_date), target.checkinDate, "Recovered check-in changed.");
	assert.equal(dateOnly(reservation.checkout_date), target.checkoutDate, "Recovered check-out changed.");
	assert.equal(Number(reservation.total_rooms), 1, "Recovered room count changed.");
	assert.equal(money(reservation.total_amount), target.grossSar, "Recovered gross changed.");
	assert.equal(money(reservation.sub_total), target.rootSar, "Recovered root changed.");
	assert.equal(money(reservation.commission_ota), target.otaCommissionSar, "Recovered Agoda commission changed.");
	assert.equal(clean(reservation.currency).toUpperCase(), "SAR", "Recovered currency changed.");
	assert.equal(lower(reservation.payment), "paid online", "Recovered payment label changed.");
	assert.equal(lower(reservation.financeStatus), "paid online", "Recovered finance status changed.");
	assert.equal(money(reservation.paid_amount), target.grossSar, "Recovered paid total changed.");
	const paid = reservation.paid_amount_breakdown || {};
	assert.equal(
		money(paid.paid_online_other_platforms),
		target.grossSar,
		"Recovered other-platform payment changed."
	);
	for (const field of [
		"paid_online_via_link",
		"paid_at_hotel_cash",
		"paid_at_hotel_card",
		"paid_to_hotel",
		"paid_online_jannatbooking",
		"paid_online_via_instapay",
		"paid_no_show",
	]) {
		assert.equal(money(paid[field]) || 0, 0, `Recovered ${field} changed.`);
	}
	assert.deepEqual((reservation.roomId || []).map(id), [], "Recovery assigned physical rooms.");
	assert.deepEqual(reservation.bedNumber || [], [], "Recovery assigned beds.");
	assert.equal((reservation.pickedRoomsType || []).length, 1, "Recovered pickedRoomsType changed.");
	assert.equal((reservation.pickedRoomsPricing || []).length, 1, "Recovered pickedRoomsPricing changed.");
	assert.deepEqual(canonicalize(reservation.pickedRoomsType), canonicalize(reservation.pickedRoomsPricing), "Recovered room arrays diverged.");
	assertAppliedRoom(target, reservation.pickedRoomsType[0], "pickedRoomsType[0]");
	assertAppliedRoom(target, reservation.pickedRoomsPricing[0], "pickedRoomsPricing[0]");
	assert.equal(money(reservation.adminPricing?.clientTotal), target.grossSar, "Recovered admin gross changed.");
	assert.equal(money(reservation.adminPricing?.rootTotal), target.rootSar, "Recovered admin root changed.");
	assert.equal(money(reservation.adminPricing?.netAfterExpensesTotal), target.payoutSar, "Recovered admin payout changed.");
	assert.equal(money(reservation.adminPricing?.otaExpenseTotal), target.expenseSar, "Recovered admin expense changed.");
	assert.equal(money(reservation.adminPricing?.platformMarginTotal), target.platformMarginSar, "Recovered admin margin changed.");
	assert.equal(lower(reservation.adminPricing?.commercialResolution), "verified", "Recovered commercial resolution changed.");
	const summary = reservation.ota_financial_summary || {};
	assert.equal(clean(summary.currency).toUpperCase(), "SAR", "Financial-summary currency changed.");
	assert.equal(money(summary.clientTotal), target.grossSar, "Financial-summary gross changed.");
	assert.equal(money(summary.hotelVisibleAmount), target.rootSar, "Financial-summary root changed.");
	assert.equal(money(summary.netAfterExpenses), target.payoutSar, "Financial-summary payout changed.");
	assert.equal(money(summary.netAfterOtaExpenses), target.payoutSar, "Financial-summary OTA-net changed.");
	assert.equal(money(summary.otaExpenseTotal), target.expenseSar, "Financial-summary expense changed.");
	assert.equal(money(summary.platformProfit), target.platformMarginSar, "Financial-summary margin changed.");
	assert.equal(money(summary.otaCommissionAmount), target.otaCommissionSar, "Financial-summary Agoda commission changed.");
	const supplier = reservation.supplierData || {};
	assert.equal(Number(supplier.otaSourceAuthority), 3, "Direct Agoda source authority changed.");
	assert.equal(
		dateIso(supplier.otaLastSourceReceivedAt),
		target.relayLastSourceReceivedAt,
		"The later relay source watermark was not preserved."
	);
	assert.equal(lower(supplier.otaLastEventType), "new", "Recovered OTA event type changed.");
	assert.equal(lower(supplier.otaProvider), target.provider, "Recovered OTA provider changed.");
	assert.equal(clean(supplier.otaCurrency).toUpperCase(), "SAR", "Supplier currency changed.");
	assert.equal(clean(supplier.otaSourceCurrency).toUpperCase(), "SAR", "Supplier source currency changed.");
	assert.equal(money(supplier.otaAmount), target.grossSar, "Supplier source gross changed.");
	assert.equal(money(supplier.otaSourceAmount), target.grossSar, "Supplier source amount changed.");
	assert.equal(money(supplier.otaAmountSar), target.grossSar, "Supplier SAR gross changed.");
	assert.equal(money(supplier.otaTotalPayoutSar), target.payoutSar, "Supplier payout changed.");
	assert.equal(money(supplier.otaExpenseTotalSar), target.expenseSar, "Supplier expense changed.");
	assert.equal(money(supplier.otaCommissionSar), target.otaCommissionSar, "Supplier commission changed.");
	assert.equal(money(supplier.otaPlatformMarginSar), target.platformMarginSar, "Supplier margin changed.");
	assert.deepEqual(
		(supplier.otaDeductionComponents || []).map((item) => money(item.amountSar)),
		target.deductionComponentsSar,
		"Supplier deduction components changed."
	);
	const commercial = supplier.otaCommercialEvidence || {};
	assert.equal(lower(commercial.verificationState), "verified", "Commercial evidence is no longer verified.");
	assert.equal(money(commercial.roles?.guestGross?.propertyAmount), target.grossSar, "Evidence gross changed.");
	assert.equal(money(commercial.roles?.hotelBase?.propertyAmount), target.rootSar, "Evidence root changed.");
	assert.equal(money(commercial.roles?.hotelPayout?.propertyAmount), target.payoutSar, "Evidence payout changed.");
	assert.equal(money(commercial.roles?.deductionAggregate?.propertyAmount), target.expenseSar, "Evidence expense changed.");
	assert.equal(money(commercial.roles?.explicitOtaCommission?.propertyAmount), target.otaCommissionSar, "Evidence commission changed.");
	const evidenceComponents = commercial.deductionComponents || [];
	assert.deepEqual(
		evidenceComponents.map((item) => money(item.amount?.propertyAmount)),
		target.deductionComponentsSar,
		"Commercial-evidence deduction components changed."
	);
	assert.equal(
		money(
			target.expenseSar -
				evidenceComponents.reduce(
					(total, item) =>
						total + Number(item.amount?.propertyAmount || 0),
					0
				)
		),
		target.unclassifiedDeductionSar,
		"Commercial-evidence unclassified deduction changed."
	);
	assert.equal(recoveryMarkerMatches(target, reservation), true, "Recovery provenance marker is missing.");
	return true;
}

function protectedReservationSnapshot(reservation = {}) {
	return canonicalize({
		id: id(reservation._id),
		version: Number(reservation.__v),
		createdAt: dateIso(reservation.createdAt),
		updatedAt: dateIso(reservation.updatedAt),
		hotelId: id(reservation.hotelId),
		belongsTo: id(reservation.belongsTo),
		reservation_id: clean(reservation.reservation_id),
		confirmation_number: clean(reservation.confirmation_number),
		otaIdentityKey: lower(reservation.otaIdentityKey),
		otaCrossTransportIdentityKey: lower(reservation.otaCrossTransportIdentityKey),
		booking_source: lower(reservation.booking_source),
		state: lower(reservation.state),
		reservation_status: lower(reservation.reservation_status),
		checkin_date: dateOnly(reservation.checkin_date),
		checkout_date: dateOnly(reservation.checkout_date),
		total_rooms: Number(reservation.total_rooms),
		total_guests: Number(reservation.total_guests),
		adults: Number(reservation.adults),
		children: Number(reservation.children),
		total_amount: reservation.total_amount ?? null,
		sub_total: reservation.sub_total ?? null,
		commission: reservation.commission ?? null,
		commission_ota: reservation.commission_ota ?? null,
		currency: clean(reservation.currency).toUpperCase(),
		payment: reservation.payment ?? null,
		financeStatus: reservation.financeStatus ?? null,
		paid_amount: reservation.paid_amount ?? null,
		paid_amount_breakdown: reservation.paid_amount_breakdown ?? null,
		payment_details: reservation.payment_details ?? null,
		financial_cycle: reservation.financial_cycle ?? null,
		moneyTransferredToHotel: reservation.moneyTransferredToHotel ?? null,
		commissionPaid: reservation.commissionPaid ?? null,
		roomId: reservation.roomId || [],
		bedNumber: reservation.bedNumber || [],
		pickedRoomsType: reservation.pickedRoomsType || [],
		pickedRoomsPricing: reservation.pickedRoomsPricing || [],
		adminPricing: reservation.adminPricing || {},
		adminPricingVisibility: reservation.adminPricingVisibility || {},
		ota_financial_summary: reservation.ota_financial_summary || {},
		otaPlatformReview: reservation.otaPlatformReview || {},
		supplierData: {
			otaProvider: reservation.supplierData?.otaProvider ?? null,
			suppliedBookingNo: reservation.supplierData?.suppliedBookingNo ?? null,
			otaConfirmationNumber: reservation.supplierData?.otaConfirmationNumber ?? null,
			platformConfirmationNumber: reservation.supplierData?.platformConfirmationNumber ?? null,
			otaSourceAuthority: reservation.supplierData?.otaSourceAuthority ?? null,
			otaSourceAmount: reservation.supplierData?.otaSourceAmount ?? null,
			otaLastSourceReceivedAt: reservation.supplierData?.otaLastSourceReceivedAt ?? null,
			otaRoomMatchType: reservation.supplierData?.otaRoomMatchType ?? null,
			otaRoomMatchScore: reservation.supplierData?.otaRoomMatchScore ?? null,
			otaPaymentCollectionModel: reservation.supplierData?.otaPaymentCollectionModel ?? null,
			directOtaArchiveCommercialRecovery:
				reservation.supplierData?.directOtaArchiveCommercialRecovery ?? null,
		},
	});
}

function assertHotelScope(target, hotel) {
	assert.ok(hotel, "Pinned HotelDetails document is missing.");
	assert.equal(id(hotel._id), target.hotelId, "Hotel ID changed.");
	assert.equal(id(hotel.belongsTo), target.ownerId, "Hotel owner changed.");
	assert.equal(clean(hotel.currency).toUpperCase(), "SAR", "Hotel currency changed.");
	assert.equal(hotel.activateHotel, true, "Hotel is not active.");
	assert.notEqual(hotel.xHotelProActive, false, "Hotel is not active in XHotelPro.");
	const rooms = (hotel.roomCountDetails || []).filter(
		(room) => id(room?._id) === target.roomConfigId
	);
	assert.equal(rooms.length, 1, "Pinned PMS room configuration is not unique.");
	const room = rooms[0];
	assert.equal(clean(room.roomType), target.roomType, "Configured room type changed.");
	assert.equal(clean(room.displayName), target.roomDisplayName, "Configured room display changed.");
	assert.notEqual(room.activeRoom, false, "Configured room is inactive.");
	const prices = (room.pricingRate || []).filter(
		(rate) => dateOnly(rate.calendarDate || rate.date) === target.checkinDate
	);
	assert.equal(prices.length, 1, "Pinned root-price calendar row is not unique.");
	assert.equal(money(prices[0].rootPrice), target.rootSar, "Pinned root price changed.");
	return room;
}

function assertFreshNormalized(target, normalized) {
	assert.equal(lower(normalized.provider), target.provider, "Fresh provider changed.");
	assert.equal(clean(normalized.confirmationNumber || normalized.reservationId), target.confirmationNumber, "Fresh confirmation changed.");
	assert.equal(lower(normalized.intent), "new_reservation", "Fresh intent changed.");
	assert.equal(lower(normalized.eventType), "new", "Fresh event changed.");
	assert.equal(normalized.sourceSenderAuthenticated, true, "Fresh parse lost authentication.");
	assert.equal(normalized.sourceSenderTrusted, true, "Fresh parse lost trusted sender status.");
	assert.equal(lower(normalized.trustedTransportProvider), target.provider, "Fresh transport changed.");
	assert.equal(normalized.requiresManualReview, false, "Fresh parser still requires review.");
	assert.equal(clean(normalized.checkinDate), target.checkinDate, "Fresh check-in changed.");
	assert.equal(clean(normalized.checkoutDate), target.checkoutDate, "Fresh check-out changed.");
	assert.equal(Number(normalized.roomCount), 1, "Fresh room count changed.");
	assert.equal(lower(normalized.source?.textHash), target.directTextHash, "Fresh source hash changed.");
	assert.equal(dateIso(normalized.source?.receivedAt), target.directSourceReceivedAt, "Fresh source time changed.");
	assert.equal(money(normalized.totalAmountSar), target.grossSar, "Fresh gross changed.");
	assert.equal(money(normalized.totalPayoutSar), target.payoutSar, "Fresh payout changed.");
	assert.equal(money(normalized.otaCommissionSar), target.otaCommissionSar, "Fresh Agoda commission changed.");
	assert.deepEqual(
		(normalized.otaDeductionComponents || []).map((item) => money(item.amountSar)),
		target.deductionComponentsSar,
		"Fresh Agoda deduction components changed."
	);
	const evidence = buildHotelRunnerEmailCommercialEvidence(normalized);
	assert.ok(evidence, "Fresh commercial evidence is incomplete.");
	assert.equal(money(evidence.grossTotalSar), target.grossSar, "Evidence gross changed.");
	assert.equal(money(evidence.payoutTotalSar), target.payoutSar, "Evidence payout changed.");
	assert.equal(money(evidence.otaExpenseTotalSar), target.expenseSar, "Evidence expense changed.");
	assert.equal(money(evidence.unclassifiedDeductionSar), target.unclassifiedDeductionSar, "Unclassified deduction changed.");
	return evidence;
}

async function queryById(Model, documentId) {
	let query = Model.findById(documentId);
	if (query && typeof query.lean === "function") query = query.lean();
	if (query && typeof query.exec === "function") return query.exec();
	return query;
}

async function loadDocuments(target, dependencies = {}) {
	const InboundModel = dependencies.InboundEmail || InboundEmail;
	const ReservationModel = dependencies.Reservations || Reservations;
	const HotelModel = dependencies.HotelDetails || HotelDetails;
	const [directAudit, relayAudit, reservation, hotel] = await Promise.all([
		queryById(InboundModel, target.directAuditId),
		queryById(InboundModel, target.relayAuditId),
		queryById(ReservationModel, target.reservationId),
		queryById(HotelModel, target.hotelId),
	]);
	return { directAudit, relayAudit, reservation, hotel };
}

function scopeHashes(scope) {
	return {
		directArchive: hashObject({
			id: id(scope.directAudit._id),
			version: Number(scope.directAudit.__v),
			emailHash: lower(scope.directAudit.emailHash),
			textHash: lower(scope.directAudit.textHash),
			dedupeKey: clean(scope.directAudit.dedupeKey),
			updatedAt: dateIso(scope.directAudit.updatedAt),
			processingStatus: lower(scope.directAudit.processingStatus),
			reservationMongoId: id(scope.directAudit.reservationMongoId),
		}),
		relayTruth: hashObject(scope.relayTruth),
		reservation: hashObject(protectedReservationSnapshot(scope.reservation)),
		hotel: hashObject({
			id: id(scope.hotel._id),
			belongsTo: id(scope.hotel.belongsTo),
			currency: clean(scope.hotel.currency).toUpperCase(),
			room: canonicalize(scope.room),
		}),
		normalized: hashObject({
			provider: scope.normalized.provider,
			confirmationNumber: scope.normalized.confirmationNumber,
			checkinDate: scope.normalized.checkinDate,
			checkoutDate: scope.normalized.checkoutDate,
			roomCount: scope.normalized.roomCount,
			totalAmountSar: scope.normalized.totalAmountSar,
			totalPayoutSar: scope.normalized.totalPayoutSar,
			otaCommissionSar: scope.normalized.otaCommissionSar,
			otaDeductionComponents: scope.normalized.otaDeductionComponents,
			sourceTextHash: scope.normalized.source?.textHash,
		}),
	};
}

function appliedDirectAudit(target, audit) {
	return !!(
		lower(audit?.reconciliation?.repairId) === REPAIR_ID &&
		id(audit?.reservationMongoId) === target.reservationId
	);
}

function assertAppliedDirectAudit(target, audit) {
	assertDirectArchiveImmutable(target, audit, {
		expectedVersion: target.directAuditVersion + 1,
	});
	assert.equal(appliedDirectAudit(target, audit), true, "Direct audit recovery tuple is incomplete.");
	assert.equal(audit.hasReservationConnection, true, "Direct audit connection is missing.");
	assert.equal(lower(audit.processingStatus), "created", "Direct audit final state changed.");
	assert.equal(lower(audit.automationAction), "updated", "Direct audit final action changed.");
	assert.equal(clean(audit.skipReason), "", "Direct audit regained a skip reason.");
	assert.equal(clean(audit.pmsConfirmationNumber), target.pmsConfirmationNumber, "Direct audit PMS link changed.");
	assert.equal(id(audit.hotelId), target.hotelId, "Direct audit hotel link changed.");
	assert.deepEqual(audit.reconciliation?.directArchiveEvidence, {
		inboundEmailId: target.directAuditId,
		emailHash: target.directEmailHash,
		textHash: target.directTextHash,
	}, "Direct audit evidence tuple changed.");
	assert.equal(money(audit.reconciliation?.grossSar), target.grossSar, "Direct audit gross changed.");
	assert.equal(money(audit.reconciliation?.payoutSar), target.payoutSar, "Direct audit payout changed.");
	assert.equal(money(audit.reconciliation?.expenseSar), target.expenseSar, "Direct audit expense changed.");
	assert.equal(audit.reconciliation?.ordinaryOtaReconciler, true, "Ordinary-reconciler proof changed.");
	assert.equal(audit.reconciliation?.hotelRunnerApiCalls, 0, "Direct audit reports a HotelRunner API call.");
	return true;
}

async function loadScope(target = TARGET, dependencies = {}) {
	const documents = await loadDocuments(target, dependencies);
	const relayTruth = assertRelayTruth(target, documents.relayAudit);
	const directApplied = appliedDirectAudit(target, documents.directAudit);
	const reservationApplied = recoveryMarkerMatches(target, documents.reservation);
	if (directApplied) assertAppliedDirectAudit(target, documents.directAudit);
	else assertOriginalDirectAudit(target, documents.directAudit);
	if (reservationApplied) assertAppliedReservation(target, documents.reservation);
	else assertOriginalReservation(target, documents.reservation);
	if (directApplied !== reservationApplied && !(!directApplied && reservationApplied)) {
		fail("RECOVERY_PARTIAL_STATE_INVALID", "Direct audit and Reservation recovery state conflict.");
	}
	const room = assertHotelScope(target, documents.hotel);
	const parse = dependencies.extractNormalizedReservation || extractNormalizedReservation;
	const normalized = parse(emailFromAudit(documents.directAudit));
	normalized.inboundEmailId = target.directAuditId;
	assertFreshNormalized(target, normalized);
	const resolveHotelImpl = dependencies.resolveHotel || resolveHotel;
	const resolvedHotel = await resolveHotelImpl(normalized, documents.reservation);
	assert.equal(id(resolvedHotel?._id), target.hotelId, "Ordinary hotel resolution changed.");
	assert.equal(id(resolvedHotel?.belongsTo), target.ownerId, "Resolved hotel owner changed.");
	const resolveRoom = dependencies.resolveRoomMatch || resolveRoomMatch;
	const roomMatch = resolveRoom(resolvedHotel, normalized.roomName, {
		totalGuests: normalized.totalGuests,
		normalized,
	});
	assert.equal(id(roomMatch?.roomDetails?._id), target.roomConfigId, "Deterministic room resolution changed.");
	assert.equal(clean(roomMatch?.roomDetails?.roomType), target.roomType, "Resolved room type changed.");
	assert.equal(clean(roomMatch?.roomDetails?.displayName), target.roomDisplayName, "Resolved room display changed.");
	assert.equal(lower(roomMatch?.matchType), target.originalRoomMatchType, "Deterministic room-match method changed.");
	assert.equal(Number(roomMatch?.score), target.originalRoomMatchScore, "Deterministic room-match score changed.");
	assert.notEqual(roomMatch?.aiRoomMatch?.usedAI, true, "Dry run used AI room matching.");
	const build = dependencies.buildReservationDocument || buildReservationDocument;
	const built = build(normalized, resolvedHotel, { roomMatch });
	assert.equal(built?.ok, true, built?.error || "Expected commercial document did not build.");
	const expected = clone(built.document);
	expected._id = target.reservationId;
	expected.confirmation_number = target.pmsConfirmationNumber;
	expected.otaIdentityKey = `agoda:${target.confirmationNumber}`;
	expected.supplierData = {
		...(expected.supplierData || {}),
		// The authoritative-refresh updater deliberately preserves the later
		// relay source-time watermark while upgrading commercial authority to the
		// direct Agoda evidence. Model that persisted result in the proof shape.
		otaLastSourceReceivedAt:
			documents.reservation.supplierData?.otaLastSourceReceivedAt,
		directOtaArchiveCommercialRecovery: recoveryMarker(target, new Date(0)),
	};
	assertAppliedReservation(target, expected);
	let action = "refresh_via_ordinary_ota_reconciler";
	if (reservationApplied && !directApplied) action = "finalize_direct_audit_only";
	if (reservationApplied && directApplied) action = "already_applied_noop";
	return {
		target,
		...documents,
		relayTruth,
		room,
		normalized,
		resolvedHotel,
		roomMatch,
		expected,
		action,
	};
}

function recoveryMarker(target, appliedAt) {
	return {
		repairId: REPAIR_ID,
		policyDate: POLICY_DATE,
		inboundEmailId: target.directAuditId,
		provider: target.provider,
		confirmationNumber: target.confirmationNumber,
		emailHash: target.directEmailHash,
		textHash: target.directTextHash,
		appliedAt: new Date(appliedAt),
		ordinaryOtaReconciler: true,
		hotelRunnerApiCalls: 0,
		outboundHttpAllowed: false,
	};
}

async function buildPlan(plannedAt = new Date(), dependencies = {}) {
	assertHotelRunnerDisabled(dependencies.env || process.env);
	assertNoForbiddenHotelRunnerRuntimeModules();
	const scope = await loadScope(TARGET, dependencies);
	scope.hashes = scopeHashes(scope);
	const basis = {
		policyDate: POLICY_DATE,
		repairId: REPAIR_ID,
		plannedAt: dateIso(plannedAt),
		target: {
			provider: TARGET.provider,
			confirmationNumber: TARGET.confirmationNumber,
			pmsConfirmationNumber: TARGET.pmsConfirmationNumber,
			reservationId: TARGET.reservationId,
			directAuditId: TARGET.directAuditId,
			relayAuditId: TARGET.relayAuditId,
			hotelId: TARGET.hotelId,
			ownerId: TARGET.ownerId,
			roomConfigId: TARGET.roomConfigId,
			stay: [TARGET.checkinDate, TARGET.checkoutDate],
			commercial: {
				grossSar: TARGET.grossSar,
				payoutSar: TARGET.payoutSar,
				expenseSar: TARGET.expenseSar,
				rootSar: TARGET.rootSar,
			},
			action: scope.action,
			hashes: scope.hashes,
		},
		hotelRunnerGates: Object.fromEntries(
			HOTELRUNNER_DISABLED_GATES.map((key) => [
				key,
				lower((dependencies.env || process.env)[key]),
			])
		),
	};
	return {
		plannedAt: new Date(plannedAt),
		planHash: hashObject(basis),
		basis,
		scope,
	};
}

const proofToken = (plan) =>
	`${new Date(plan.plannedAt).getTime()}.${plan.planHash}`;

function setPath(document, dotted, value) {
	const parts = String(dotted).split(".");
	const final = parts.pop();
	let cursor = document;
	for (const part of parts) {
		if (!cursor[part] || typeof cursor[part] !== "object") cursor[part] = {};
		cursor = cursor[part];
	}
	cursor[final] = clone(value);
}

function applyUpdateForProof(original, update) {
	const document = clone(original);
	for (const [path, value] of Object.entries(update.$set || {})) {
		setPath(document, path, value);
	}
	for (const [path, value] of Object.entries(update.$inc || {})) {
		const parts = path.split(".");
		const current = parts.reduce((cursor, part) => cursor?.[part], document);
		setPath(document, path, Number(current || 0) + Number(value));
	}
	return document;
}

function pinnedReservationCasFilter(target, reservation) {
	return {
		_id: target.reservationId,
		__v: target.reservationVersion,
		updatedAt: new Date(target.reservationUpdatedAt),
		hotelId: target.hotelId,
		belongsTo: target.ownerId,
		otaIdentityKey: `agoda:${target.confirmationNumber}`,
		state: reservation.state,
		reservation_status: reservation.reservation_status,
		total_amount: null,
		sub_total: target.rootSar,
		commission_ota: null,
		roomId: reservation.roomId,
		bedNumber: reservation.bedNumber,
		pickedRoomsType: reservation.pickedRoomsType,
		pickedRoomsPricing: reservation.pickedRoomsPricing,
		adminPricing: reservation.adminPricing,
		ota_financial_summary: reservation.ota_financial_summary,
		"supplierData.otaSourceAuthority": 1,
		"supplierData.otaSourceAmount": target.payoutSar,
		"supplierData.otaLastSourceReceivedAt": new Date(
			target.relayLastSourceReceivedAt
		),
		"supplierData.directOtaArchiveCommercialRecovery": null,
	};
}

async function assertScopeUnchanged(scope, dependencies = {}) {
	const current = await loadScope(scope.target, dependencies);
	const currentHashes = scopeHashes(current);
	assert.deepEqual(currentHashes, scope.hashes, "Proof-bound recovery scope drifted before write.");
	assert.equal(current.action, scope.action, "Recovery action changed before write.");
	return current;
}

async function assertReadyToFinalizeDirectAudit(scope, dependencies = {}) {
	const current = await loadDocuments(scope.target, dependencies);
	assertOriginalDirectAudit(scope.target, current.directAudit);
	assertAppliedReservation(scope.target, current.reservation);
	const currentRelayTruth = assertRelayTruth(scope.target, current.relayAudit);
	assert.deepEqual(
		currentRelayTruth,
		scope.relayTruth,
		"HotelRunner relay audit truth changed before direct-audit finalization."
	);
	const room = assertHotelScope(scope.target, current.hotel);
	assert.equal(
		hashObject({
			id: id(current.hotel._id),
			belongsTo: id(current.hotel.belongsTo),
			currency: clean(current.hotel.currency).toUpperCase(),
			room: canonicalize(room),
		}),
		scope.hashes.hotel,
		"Hotel or PMS room configuration changed before direct-audit finalization."
	);
	return current;
}

async function withProofBoundReservationUpdate(scope, plan, dependencies, work) {
	const ReservationModel = dependencies.Reservations || Reservations;
	const originalUpdateOne = ReservationModel.updateOne;
	assert.equal(typeof originalUpdateOne, "function", "Reservation updateOne is unavailable.");
	let calls = 0;
	ReservationModel.updateOne = async function guardedUpdateOne(filter, update, options) {
		calls += 1;
		assert.equal(calls, 1, "Ordinary reconciliation attempted more than one Reservation write.");
		assert.equal(id(filter?._id), scope.target.reservationId, "Ordinary reconciliation targeted another Reservation.");
		await assertScopeUnchanged(scope, dependencies);
		const stamped = clone(update);
		stamped.$set = {
			...(stamped.$set || {}),
			"supplierData.directOtaArchiveCommercialRecovery": recoveryMarker(
				scope.target,
				plan.plannedAt
			),
		};
		assert.equal(Number(stamped.$inc?.__v), 1, "Ordinary reconciliation lost its version CAS bump.");
		const proposed = applyUpdateForProof(scope.reservation, stamped);
		assertAppliedReservation(scope.target, proposed);
		const guardedFilter = {
			$and: [
				filter,
				pinnedReservationCasFilter(scope.target, scope.reservation),
			],
		};
		return originalUpdateOne.call(ReservationModel, guardedFilter, stamped, options);
	};
	try {
		return await work();
	} finally {
		ReservationModel.updateOne = originalUpdateOne;
		assert.equal(calls, 1, "Ordinary reconciliation did not perform the one proof-bound Reservation write.");
	}
}

async function withOutboundHttpBlocked(work) {
	const hadFetch = Object.prototype.hasOwnProperty.call(globalThis, "fetch");
	const originals = {
		httpRequest: http.request,
		httpGet: http.get,
		httpsRequest: https.request,
		httpsGet: https.get,
		fetch: globalThis.fetch,
	};
	const blocked = () => {
		fail(
			"RECOVERY_OUTBOUND_NETWORK_BLOCKED",
			"Outbound HTTP is disabled during this recovery."
		);
	};
	http.request = blocked;
	http.get = blocked;
	https.request = blocked;
	https.get = blocked;
	globalThis.fetch = blocked;
	try {
		return await work();
	} finally {
		http.request = originals.httpRequest;
		http.get = originals.httpGet;
		https.request = originals.httpsRequest;
		https.get = originals.httpsGet;
		if (hadFetch) globalThis.fetch = originals.fetch;
		else delete globalThis.fetch;
	}
}

function directAuditUpdate(scope, reconciliation, reservation, plannedAt) {
	const target = scope.target;
	return {
		$set: {
			provider: target.provider,
			confirmationNumber: target.confirmationNumber,
			processingStatus: "created",
			automationAction: "updated",
			skipReason: "",
			automationComment:
				"Authenticated direct Agoda commercial facts refreshed the exact pending PMS review through the ordinary OTA reconciler.",
			hasReservationConnection: true,
			reservationMongoId: reservation._id,
			pmsConfirmationNumber: target.pmsConfirmationNumber,
			hotelId: reservation.hotelId,
			normalizedReservation: scope.normalized,
			sourceAmount: target.grossSar,
			sourceCurrency: "SAR",
			totalAmountSar: target.grossSar,
			exchangeRateToSar: 1,
			exchangeRateSource: "identity",
			paymentCollectionModel: scope.normalized.paymentCollectionModel || "",
			reconciliation: {
				status: "updated",
				actionTaken: "commercial_refresh",
				reservationId: target.reservationId,
				hotelId: target.hotelId,
				pmsConfirmationNumber: target.pmsConfirmationNumber,
				matchedReservationBy: reconciliation?.matchedReservationBy || [],
				repairId: REPAIR_ID,
				policyDate: POLICY_DATE,
				recoveredFromInboundAudit: true,
				ordinaryOtaReconciler: true,
				hotelRunnerApiCalls: 0,
				outboundHttpAllowed: false,
				grossSar: target.grossSar,
				payoutSar: target.payoutSar,
				expenseSar: target.expenseSar,
				rootSar: target.rootSar,
				directArchiveEvidence: {
					inboundEmailId: target.directAuditId,
					emailHash: target.directEmailHash,
					textHash: target.directTextHash,
				},
				relayEvidencePreserved: {
					inboundEmailId: target.relayAuditId,
					emailHash: target.relayEmailHash,
					textHash: target.relayTextHash,
					reservationId: target.reservationId,
				},
			},
			orchestratorDecision: {
				usedAI: false,
				skipped: true,
				skipReason: "dated_authenticated_direct_archive_refresh",
				repairId: REPAIR_ID,
				policyDate: POLICY_DATE,
			},
			processedAt: new Date(plannedAt),
		},
		$inc: { __v: 1 },
	};
}

async function finalizeDirectAudit(scope, reconciliation, reservation, plan, dependencies = {}) {
	const Model = dependencies.InboundEmail || InboundEmail;
	const target = scope.target;
	await assertReadyToFinalizeDirectAudit(scope, dependencies);
	const result = await Model.updateOne(
		{
			_id: target.directAuditId,
			__v: target.directAuditVersion,
			updatedAt: new Date(target.directAuditUpdatedAt),
			provider: target.provider,
			confirmationNumber: target.confirmationNumber,
			emailHash: target.directEmailHash,
			textHash: target.directTextHash,
			dedupeKey: target.directDedupeKey,
			processingStatus: "needs_review",
			skipReason: "ota_parser_requires_manual_review",
			reservationMongoId: null,
			"senderAuthentication.authenticatedAligned": true,
			"senderAuthentication.dkimAlignedPass": true,
			"senderAuthentication.trustedProvider": target.provider,
		},
		directAuditUpdate(scope, reconciliation, reservation, plan.plannedAt),
		{ writeConcern: { w: "majority" } }
	);
	const matched = Number(result?.matchedCount ?? result?.n ?? 0);
	if (matched !== 1) {
		const observed = await queryById(Model, target.directAuditId);
		if (!appliedDirectAudit(target, observed)) {
			fail("RECOVERY_DIRECT_AUDIT_CAS_LOST", "Direct audit changed before finalization.");
		}
	}
	const finalAudit = await queryById(Model, target.directAuditId);
	assertAppliedDirectAudit(target, finalAudit);
	return finalAudit;
}

async function applyRecovery(plan, dependencies = {}) {
	assertHotelRunnerDisabled(dependencies.env || process.env);
	assertNoForbiddenHotelRunnerRuntimeModules();
	const scope = plan.scope;
	const target = scope.target;
	if (scope.action === "already_applied_noop") {
		return { action: scope.action, reservationId: target.reservationId };
	}
	let reservation = scope.reservation;
	let reconciliation = null;
	if (scope.action === "refresh_via_ordinary_ota_reconciler") {
		const reconcile = dependencies.reconcileOtaReservation || reconcileOtaReservation;
		reconciliation = await withProofBoundReservationUpdate(
			scope,
			plan,
			dependencies,
			() =>
				withOutboundHttpBlocked(() =>
					reconcile(scope.normalized, {
						sarConversionOptions: {
							apiKey: "network-disabled-proof-bound-recovery",
							cache: new Map(),
							fetchImpl: async () =>
								fail(
									"RECOVERY_EXCHANGE_NETWORK_ATTEMPT",
									"Exchange-rate network access is disabled."
								),
						},
					})
				)
		);
		assert.equal(lower(reconciliation?.status), "updated", "Ordinary reconciliation did not update the exact Reservation.");
		assert.equal(id(reconciliation?.reservationId), target.reservationId, "Ordinary reconciliation selected another Reservation.");
		reservation = await queryById(
			dependencies.Reservations || Reservations,
			target.reservationId
		);
		assertAppliedReservation(target, reservation);
	} else {
		assertAppliedReservation(target, reservation);
	}
	await finalizeDirectAudit(scope, reconciliation, reservation, plan, dependencies);
	const finalDocuments = await loadDocuments(target, dependencies);
	assertAppliedReservation(target, finalDocuments.reservation);
	assertAppliedDirectAudit(target, finalDocuments.directAudit);
	const finalRelayTruth = assertRelayTruth(target, finalDocuments.relayAudit);
	assert.deepEqual(finalRelayTruth, scope.relayTruth, "HotelRunner relay audit truth was mutated.");
	return {
		action: scope.action,
		reservationId: target.reservationId,
		directAuditId: target.directAuditId,
		relayAuditPreserved: true,
	};
}

function safeOutput(plan, mode) {
	return {
		mode,
		policyDate: POLICY_DATE,
		repairId: REPAIR_ID,
		plannedAt: dateIso(plan.plannedAt),
		planHash: plan.planHash,
		target: {
			provider: TARGET.provider,
			confirmationNumber: TARGET.confirmationNumber,
			pmsConfirmationNumber: TARGET.pmsConfirmationNumber,
			reservationId: TARGET.reservationId,
			directAuditId: TARGET.directAuditId,
			relayAuditId: TARGET.relayAuditId,
			hotelId: TARGET.hotelId,
			roomConfigId: TARGET.roomConfigId,
			stay: [TARGET.checkinDate, TARGET.checkoutDate],
			roomCount: TARGET.roomCount,
			grossSar: TARGET.grossSar,
			payoutSar: TARGET.payoutSar,
			expenseSar: TARGET.expenseSar,
			rootSar: TARGET.rootSar,
			action: plan.scope.action,
		},
		hotelRunnerApiCalls: 0,
		outboundHttpAllowed: false,
	};
}

async function run(options = parseArguments(), dependencies = {}) {
	assertHotelRunnerDisabled(dependencies.env || process.env);
	assertNoForbiddenHotelRunnerRuntimeModules();
	const database =
		dependencies.database ||
		process.env.DATABASE ||
		process.env.MONGO_URI ||
		process.env.MONGODB_URI;
	assert.ok(database || dependencies.skipConnect, "Missing MongoDB connection string.");
	if (!dependencies.skipConnect) await mongoose.connect(database, { autoIndex: false });
	const now = dependencies.now?.() || new Date();
	const proof = options.apply ? parseProof(options.proof, now) : null;
	const plan = await buildPlan(proof?.plannedAt || now, dependencies);
	if (options.apply && proofToken(plan) !== options.proof) {
		fail("RECOVERY_PLAN_CHANGED", "Live recovery scope no longer matches the dry-run proof.");
	}
	const output = safeOutput(plan, options.apply ? "apply" : "dry-run");
	if (!options.apply) {
		output.proof = proofToken(plan);
		output.proofExpiresInMinutes = PROOF_MAX_AGE_MS / 60000;
		output.applyCommand = `node scripts/recoverAgoda2041108213Commercial20260813.js --apply --repair-id=${REPAIR_ID} --proof=${output.proof}`;
		console.log(JSON.stringify(output, null, 2));
		return output;
	}
	const result = await applyRecovery(plan, dependencies);
	const final = { ...output, success: true, result };
	console.log(JSON.stringify(final, null, 2));
	return final;
}

if (require.main === module) {
	run()
		.catch((error) => {
			console.error(
				JSON.stringify(
					{
						success: false,
						code: error.code || "RECOVERY_FAILED",
						message: clean(error.message),
					},
					null,
					2
				)
			);
			process.exitCode = 1;
		})
		.finally(async () => {
			if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
		});
}

module.exports = {
	CLOCK_SKEW_MS,
	FORBIDDEN_HOTELRUNNER_RUNTIME_MODULES,
	HOTELRUNNER_DISABLED_GATES,
	POLICY_DATE,
	PROOF_MAX_AGE_MS,
	REPAIR_ID,
	RecoverySafetyError,
	TARGET,
	applyRecovery,
	applyUpdateForProof,
	assertAppliedDirectAudit,
	assertAppliedReservation,
	assertDirectArchiveImmutable,
	assertFreshNormalized,
	assertHotelRunnerDisabled,
	assertHotelScope,
	assertNoForbiddenHotelRunnerRuntimeModules,
	assertOriginalDirectAudit,
	assertOriginalReservation,
	assertRelayTruth,
	buildPlan,
	canonicalize,
	directAuditUpdate,
	emailFromAudit,
	hashObject,
	loadScope,
	loadedForbiddenHotelRunnerModules,
	parseArguments,
	parseProof,
	pinnedReservationCasFilter,
	proofToken,
	protectedReservationSnapshot,
	recoveryMarker,
	recoveryMarkerMatches,
	relayTruthSnapshot,
	run,
	safeOutput,
	scopeHashes,
	withOutboundHttpBlocked,
	withProofBoundReservationUpdate,
};
