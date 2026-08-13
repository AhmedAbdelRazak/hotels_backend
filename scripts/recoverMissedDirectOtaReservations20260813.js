/** @format */

"use strict";

// Dated, closed-scope recovery for three authenticated direct OTA archives.
// This command is dry-run only unless an unexpired dry-run proof and the exact
// repair ID are supplied. It deliberately does not import any HotelRunner
// client, adapter, worker, controller, route, or configuration module.

require("dotenv").config();

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const mongoose = require("mongoose");

mongoose.set("strictQuery", true);

const InboundEmail = require("../models/inbound_email");
const Reservations = require("../models/reservations");
const {
	validateReservationInventoryForCreate,
} = require("../controllers/reservations");
const {
	applyDatedRecoveryConversionBoundary,
	buildDatedRecoveryConversionBoundary,
	buildOtaConfirmationLookup,
	buildOtaCrossTransportIdentityKey,
	buildOtaIdentityKey,
	buildReservationDocument,
	datedRecoveryBoundaryHash,
	extractNormalizedReservation,
	generateDateRange,
	hashText,
	normalizeComparable,
	normalizeConfirmation,
	reconcileOtaReservation,
	resolveHotel,
	resolveRoomMatch,
} = require("../services/otaReservationMapper");

const REPAIR_ID = "missed-direct-ota-email-recovery-20260813-v1";
const POLICY_DATE = "2026-08-13";
const PROOF_MAX_AGE_MS = 30 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const TRIP_DATED_RECOVERY_TUPLE_HASH =
	"ff333154cdbdad71b406deb7e3c3cca041245d861638bc2bc48b05e122b572e5";
const HOTEL_ID = "6a40b6a1a6efe70450536038";
const OWNER_ID = "68b74714fb50e159d48c714d";
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

const TARGETS = Object.freeze([
	Object.freeze({
		provider: "agoda",
		confirmationNumber: "689553735",
		auditId: "6a7e336d0efaa0e2faa437a9",
		emailHash: "b16366888702c6a57190c52e84c3271e21463efcf0f91f5a9310b26ee6096869",
		textHash: "4f637ee7dc8f55ad8fcf38b2e37d0351f938d583be55acddb997f8f27d86c56d",
		messageIdHash: "1a983f9174becdc613fe3b98689eaa781d240ca975646d44bd8705380ed627e5",
		dedupeKeyHash: "43abcf4fa6767fd17d034111e3cfdabd98b9056a4db973f2918cb3d38ccc3d93",
		from: '"agoda.com" <no-reply@agoda.com>',
		subject: "Agoda Booking ID 689553735 - CONFIRMED Hotel Country: Saudi Arabia Check-in August 20, 2026 / Language_English",
		sourceReceivedAt: "2026-08-13T21:13:12.000Z",
		receivedAt: "2026-08-13T21:13:17.712Z",
		createdAt: "2026-08-13T21:13:17.725Z",
		updatedAt: "2026-08-13T21:13:44.112Z",
		version: 0,
		guestKeyHash: "4d73548ea0db1ba9395cbd98c4b3add47f23943b3c76b478025ab25cc5e83a63",
		propertyId: "90720772",
		roomConfigId: "6a40df5f1a6d1850eb25c183",
		roomType: "doubleRooms",
		checkinDate: "2026-08-20",
		checkoutDate: "2026-08-22",
		roomCount: 2,
		totalGuests: 4,
		sourceCurrency: "SAR",
		sourceGross: 288,
		sourcePayout: 178.2,
		grossSar: 288,
		payoutSar: 178.2,
		expenseSar: 109.8,
		otaCommissionSar: 43.2,
		rootSar: 300,
		platformMarginSar: -121.8,
		expectedNightGross: Object.freeze([[72, 72], [72, 72]]),
		expectedNightPayout: Object.freeze([[44.55, 44.55], [44.55, 44.55]]),
		expectedNightRoot: Object.freeze([[75, 75], [75, 75]]),
		expectedOverbooked: true,
		expectedRoomMatchType: "explicit_capacity",
		expectedRoomMatchScore: 0.98,
	}),
	Object.freeze({
		provider: "agoda",
		confirmationNumber: "689554695",
		auditId: "6a7e34400efaa0e2faa43887",
		emailHash: "91f49120593c3e970bf985e02836a101f36bd30790c3b2ff1333989df3607420",
		textHash: "322ac57abaa385ad78022c982f2c2e28334d4f5d1bd82353c8b69d2aa41c50fd",
		messageIdHash: "a8b381ab5f625c177c27836ca2981d4f72b8b26c9ff63170db668d489ee09de1",
		dedupeKeyHash: "3088767716f4827f0290ac4abd5b03fe03d5db2d81fec5b23f60540278ae516a",
		from: '"agoda.com" <no-reply@agoda.com>',
		subject: "Agoda Booking ID 689554695 - CONFIRMED Hotel Country: Saudi Arabia Check-in August 14, 2026 / Language_English",
		sourceReceivedAt: "2026-08-13T21:16:44.000Z",
		receivedAt: "2026-08-13T21:16:48.917Z",
		createdAt: "2026-08-13T21:16:48.931Z",
		updatedAt: "2026-08-13T21:17:30.732Z",
		version: 0,
		guestKeyHash: "9baf27c20b170855d029519b06669e4138e3046567de0bb1e46ee83e50df98e3",
		propertyId: "90720772",
		roomConfigId: "6a40e4ec1a6d1850eb25c635",
		roomType: "familyRooms",
		checkinDate: "2026-08-14",
		checkoutDate: "2026-08-15",
		roomCount: 2,
		totalGuests: 7,
		sourceCurrency: "SAR",
		sourceGross: 176.4,
		sourcePayout: 109.16,
		grossSar: 176.4,
		payoutSar: 109.16,
		expenseSar: 67.24,
		otaCommissionSar: 26.46,
		rootSar: 150,
		platformMarginSar: -40.84,
		expectedNightGross: Object.freeze([[88.2], [88.2]]),
		expectedNightPayout: Object.freeze([[54.58], [54.58]]),
		expectedNightRoot: Object.freeze([[75], [75]]),
		expectedOverbooked: false,
		expectedRoomMatchType: "explicit_capacity",
		expectedRoomMatchScore: 0.98,
	}),
	Object.freeze({
		provider: "trip",
		confirmationNumber: "1567953939695657",
		auditId: "6a778411bf632980ba060016",
		emailHash: "45d0378aebd409e4fa03395f12d257b28024249dd7e2c10a67419f997a3847a9",
		textHash: "51cf294c36171862d72880b2551f680c28a639fa60dc4350b4e070cd7f917beb",
		messageIdHash: "c622ffc5d925444213f2732814d5fd7e4a780da4cd6d0b5fdf7a016021f6cd47",
		dedupeKeyHash: "0553cc4522c1c6d6e95c56eebf96b10baff63b0faadc810dd85f61563e2a6b94",
		from: "noreply_htl@trip.com",
		subject: "Booking no. #1567953939695657# accepted",
		sourceReceivedAt: "2026-08-08T19:31:24.000Z",
		receivedAt: "2026-08-08T19:31:29.694Z",
		createdAt: "2026-08-08T19:31:29.723Z",
		updatedAt: "2026-08-08T19:31:30.681Z",
		version: 0,
		guestKeyHash: "10a9f514493db56b445d5a5527032434b2231419bb7ea8f40596603748a87ed8",
		propertyId: "",
		roomConfigId: "6a40e0981a6d1850eb25c27c",
		roomType: "tripleRooms",
		checkinDate: "2026-08-12",
		checkoutDate: "2026-08-15",
		roomCount: 2,
		totalGuests: 5,
		sourceCurrency: "USD",
		sourceGross: 99.42,
		sourcePayout: 93.9,
		exchangeRateToSar: 3.75,
		grossSar: 372.83,
		payoutSar: 352.13,
		expenseSar: 20.7,
		otaCommissionSar: null,
		rootSar: 450,
		platformMarginSar: -97.87,
		legacySkippedGrossSar: 372.82,
		legacySkippedPayoutSar: 352.13,
		archivedExchangeRateSource: "exchange_rate_api_cached",
		archivedAmountConvertedAt: "2026-08-08T19:31:30.244Z",
		expectedNightGross: Object.freeze([[60.23, 60.23, 65.97], [60.22, 60.22, 65.96]]),
		expectedNightPayout: Object.freeze([[56.89, 56.89, 62.29], [56.89, 56.89, 62.28]]),
		expectedNightRoot: Object.freeze([[75, 75, 75], [75, 75, 75]]),
		expectedOverbooked: true,
		expectedRoomMatchType: "explicit_capacity",
		expectedRoomMatchScore: 0.98,
		expectedDormantHotelRunnerState: Object.freeze({
			event: Object.freeze({
				id: "6a77841ed8cbed2f4bad4714",
				hotelId: "6a40b6a1a6efe70450536038",
				eventKey: "63f73679f12514dcf9edc19a5253b49d0c2b851082c54cf9aa236d2da944d328",
				messageUid: "895182ac5f05d0aa26d5cd707bdd1883",
				payloadHash: "f5ed38f11a35d0ceec74732cb6b4f9edfc7d6cc83668ed3059b90d0553fd9ed7",
				canonicalHash: "cc168a699384b6cccba3921066ccdc354cf2199fcdaac189d5287c5677a32593",
				source: "push",
				hotelRunnerReservationId: "40367538",
				hrNumber: "R367587618",
				providerNumber: "1567953939695657",
				channel: "tripcom",
				state: "confirmed",
				modified: false,
				status: "failed",
				attempts: 8,
				sourceUpdatedAt: "2026-08-08T19:31:38.000Z",
				finalRecoveryAttempted: false,
				integrityReason: "",
				integrityConflict: false,
				integrityConflictCount: 0,
				errorCode: "hotelrunner_currency_waiting_for_email_bridge",
				errorMessageHash: "b42cd6a612e1f79ede57294c3f3eabcc8ae997a7482c6a3ce52dd105024efac6",
				reservationMongoId: "",
				mirrorId: "",
			}),
			mirror: Object.freeze({
				id: "6a77841fde7b4b5990ab845a",
				hotelId: "6a40b6a1a6efe70450536038",
				hrIdFingerprint: "841c04f692db5420e2c631afd2e1f3d916e9aa4699a8d778e883b376d48f0a07",
				hotelRunnerReservationId: "40367538",
				hrNumber: "R367587618",
				providerNumber: "1567953939695657",
				hrNumberAliases: Object.freeze(["R367587618"]),
				providerNumberAliases: Object.freeze(["1567953939695657"]),
				channel: "tripcom",
				channelDisplay: "Trip.com V2",
				sourceDisplay: "",
				state: "confirmed",
				modified: false,
				observedSourceUpdatedAt: "2026-08-08T19:31:38.000Z",
				observedCanonicalHash: "cc168a699384b6cccba3921066ccdc354cf2199fcdaac189d5287c5677a32593",
				lastMessageUid: "895182ac5f05d0aa26d5cd707bdd1883",
				projectionStatus: "pending",
				projectionVersion: 0,
				identityConflict: false,
				reservationMongoId: "",
				appliedSourceUpdatedAt: "",
				appliedCanonicalHash: "",
				linkMethod: "",
				linkedAt: "",
				linkEvidenceKeys: Object.freeze([]),
			}),
		}),
	}),
]);

const clean = (value) => String(value ?? "").trim();
const lower = (value) => clean(value).toLowerCase();
const id = (value) => lower(value?._id || value);
const money = (value) => Number(Number(value || 0).toFixed(2));
const sha256 = (value) => crypto.createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
const dateIso = (value) => {
	if (value === null || value === undefined || value === "") return "";
	const parsed = value instanceof Date ? value : new Date(value);
	return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : "";
};
const dateOnly = (value) => {
	if (value instanceof Date) return dateIso(value).slice(0, 10);
	const text = clean(value);
	const leading = text.match(/^(\d{4}-\d{2}-\d{2})/);
	if (leading) return leading[1];
	const parsed = new Date(value);
	return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : "";
};

class RecoverySafetyError extends Error {
	constructor(code, message, details = {}) {
		super(message);
		this.name = "RecoverySafetyError";
		this.code = code;
		this.details = details;
	}
}

function fail(code, message, details = {}) {
	throw new RecoverySafetyError(code, message, details);
}

function parseArguments(argv = process.argv.slice(2)) {
	const options = { apply: false, repairId: "", proof: "" };
	for (let index = 0; index < argv.length; index += 1) {
		const item = String(argv[index] || "");
		if (item === "--apply") options.apply = true;
		else if (item.startsWith("--repair-id=")) options.repairId = clean(item.slice(12));
		else if (item === "--repair-id") options.repairId = clean(argv[++index]);
		else if (item.startsWith("--proof=")) options.proof = lower(item.slice(8));
		else if (item === "--proof") options.proof = lower(argv[++index]);
		else fail("RECOVERY_ARGUMENT_UNKNOWN", `Unknown argument: ${item}`);
	}
	if (!options.apply && (options.repairId || options.proof)) {
		fail("RECOVERY_DRY_RUN_ARGUMENT", "--repair-id and --proof are accepted only with --apply.");
	}
	if (options.apply && options.repairId !== REPAIR_ID) {
		fail("RECOVERY_REPAIR_ID_REQUIRED", `--apply requires --repair-id=${REPAIR_ID}.`);
	}
	if (options.apply && !/^\d{13}\.[a-f0-9]{64}$/.test(options.proof)) {
		fail("RECOVERY_PROOF_REQUIRED", "--apply requires the exact unexpired dry-run proof.");
	}
	return options;
}

function parseProof(proof, now = new Date()) {
	const match = lower(proof).match(/^(\d{13})\.([a-f0-9]{64})$/);
	if (!match) fail("RECOVERY_PROOF_INVALID", "Dry-run proof format is invalid.");
	const plannedAtMs = Number(match[1]);
	const nowMs = new Date(now).getTime();
	if (!Number.isSafeInteger(plannedAtMs) || plannedAtMs > nowMs + CLOCK_SKEW_MS || nowMs - plannedAtMs > PROOF_MAX_AGE_MS) {
		fail("RECOVERY_PROOF_EXPIRED", "Dry-run proof is expired or from the future.");
	}
	return { plannedAt: new Date(plannedAtMs), planHash: match[2] };
}

function assertHotelRunnerDisabled(env = process.env) {
	for (const key of HOTELRUNNER_DISABLED_GATES) {
		if (lower(env[key]) !== "false") {
			fail("RECOVERY_HOTELRUNNER_GATE_OPEN", `${key} must be explicitly false.`);
		}
	}
	return true;
}

function loadedForbiddenHotelRunnerModules(cache = require.cache) {
	const loaded = Object.keys(cache || {});
	return FORBIDDEN_HOTELRUNNER_RUNTIME_MODULES.filter((basename) =>
		loaded.some((filename) => filename.replace(/\\/g, "/").endsWith(`/${basename}`))
	);
}

function assertNoForbiddenHotelRunnerRuntimeModules(cache = require.cache) {
	const forbidden = loadedForbiddenHotelRunnerModules(cache);
	if (forbidden.length) {
		fail("RECOVERY_HOTELRUNNER_RUNTIME_MODULE_LOADED", "A HotelRunner network/runtime module is loaded; recovery stopped.", { modules: forbidden });
	}
	return true;
}

function normalizeGuestKey(value) {
	return clean(value).normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}

function guestKeyHash(value) {
	return sha256(normalizeGuestKey(value));
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
		sourceReceivedAt: source.receivedAt || source.messageDate || audit.receivedAt,
		sourceTimestampMethod: source.timestampMethod || "",
		senderAuthentication: audit.senderAuthentication || {},
	};
}

function assertArchiveImmutable(target, audit) {
	assert.ok(audit, `Missing inbound archive ${target.auditId}.`);
	assert.equal(id(audit._id), target.auditId, "Archive ID changed.");
	assert.equal(audit.source, "sendgrid", "Archive source changed.");
	assert.equal(lower(audit.provider), target.provider, "Archive provider changed.");
	assert.equal(normalizeConfirmation(audit.confirmationNumber), target.confirmationNumber, "Archive confirmation changed.");
	assert.equal(audit.emailHash, target.emailHash, "Archive email hash changed.");
	assert.equal(audit.textHash, target.textHash, "Archive text hash changed.");
	assert.equal(hashText(audit.bodyText || ""), target.textHash, "Archived body no longer matches text hash.");
	assert.equal(String(audit.bodyHtml || ""), "", "Archived HTML body changed from the pinned empty representation.");
	assert.equal(sha256(audit.messageId || ""), target.messageIdHash, "Message-ID hash changed.");
	assert.equal(sha256(audit.dedupeKey || ""), target.dedupeKeyHash, "Dedupe-key hash changed.");
	assert.equal(clean(audit.from), target.from, "Direct sender changed.");
	assert.equal(clean(audit.subject), target.subject, "Subject changed.");
	assert.equal(dateIso(audit.receivedAt), target.receivedAt, "Delivery timestamp changed.");
	assert.equal(dateIso(audit.createdAt), target.createdAt, "Archive creation timestamp changed.");
	assert.equal(Number(audit.__v), target.version, "Archive version changed.");
	assert.equal(Boolean(audit.duplicateOf), false, "Direct archive became a duplicate.");
	assert.equal(audit.senderAuthentication?.authenticatedAligned, true, "Aligned sender authentication was lost.");
	assert.equal(audit.senderAuthentication?.dkimAlignedPass, true, "Aligned DKIM proof was lost.");
	assert.equal(lower(audit.senderAuthentication?.trustedProvider), target.provider, "Trusted sender provider changed.");
	assert.equal(lower(audit.senderAuthentication?.fromDomain), `${target.provider}.com`, "Authenticated From domain changed.");
	assert.equal(lower(audit.senderAuthentication?.method), "dkim", "Authentication method changed.");
	assert.equal(lower(audit.senderAuthentication?.reason), "authenticated_aligned_sender", "Authentication reason changed.");
	assert.deepEqual((audit.senderAuthentication?.alignedDkimPassDomains || []).map(lower), [`${target.provider}.com`], "Aligned DKIM domain changed.");
	return true;
}

function assertOriginalAuditState(target, audit) {
	assert.equal(dateIso(audit.updatedAt), target.updatedAt, "Original archive update timestamp changed.");
	assert.equal(lower(audit.processingStatus), "needs_review", "Archive is no longer in its reviewed pre-recovery state.");
	assert.equal(lower(audit.skipReason), "ota_parser_requires_manual_review", "Archive skip reason changed.");
	assert.equal(id(audit.reservationMongoId), "", "Archive is already linked to a reservation.");
	assert.equal(lower(audit.reconciliation?.repairId), "", "Archive already contains a different reconciliation marker.");
}

function assertAppliedAuditState(target, audit) {
	const reconciliation = audit.reconciliation || {};
	assert.equal(lower(reconciliation.repairId), REPAIR_ID, "Applied archive repair marker changed.");
	assert.equal(reconciliation.policyDate, POLICY_DATE, "Applied archive recovery policy date changed.");
	assert.equal(id(audit.reservationMongoId).length, 24, "Applied archive lacks a reservation link.");
	assert.equal(audit.hasReservationConnection, true, "Applied archive lost its reservation connection.");
	assert.equal(lower(audit.processingStatus), "created", "Applied archive processing state changed.");
	assert.equal(lower(audit.automationAction), "created", "Applied archive automation action changed.");
	assert.equal(clean(audit.skipReason), "", "Applied archive regained a skip reason.");
	assert.equal(lower(audit.provider), target.provider, "Applied archive provider changed.");
	assert.equal(normalizeConfirmation(audit.confirmationNumber), target.confirmationNumber, "Applied archive confirmation changed.");
	assert.equal(money(audit.sourceAmount), target.sourceGross, "Applied archive source gross changed.");
	assert.equal(clean(audit.sourceCurrency).toUpperCase(), target.sourceCurrency, "Applied archive source currency changed.");
	assert.equal(money(audit.totalAmountSar), target.grossSar, "Applied archive SAR gross changed.");
	assert.equal(Number(audit.exchangeRateToSar), Number(target.exchangeRateToSar || 1), "Applied archive exchange rate changed.");
	assert.equal(id(audit.hotelId), HOTEL_ID, "Applied archive hotel link changed.");
	assert.equal(id(reconciliation.reservationId), id(audit.reservationMongoId), "Applied reconciliation reservation link changed.");
	assert.equal(id(reconciliation.hotelId), HOTEL_ID, "Applied reconciliation hotel link changed.");
	assert.equal(clean(reconciliation.pmsConfirmationNumber), clean(audit.pmsConfirmationNumber), "Applied PMS confirmation tuple changed.");
	assert.ok(clean(audit.pmsConfirmationNumber), "Applied archive PMS confirmation is missing.");
	assert.equal(reconciliation.recoveredFromInboundAudit, true, "Applied reconciliation lost direct-archive provenance.");
	assert.equal(reconciliation.ordinaryOtaReconciler, true, "Applied reconciliation lost ordinary-reconciler provenance.");
	assert.equal(reconciliation.orderTakerNormalizationUsed, false, "Applied reconciliation reports OrderTaker normalization.");
	assert.deepEqual(reconciliation.directArchiveEvidence, {
		inboundEmailId: target.auditId,
		emailHash: target.emailHash,
		textHash: target.textHash,
	}, "Applied direct-archive evidence tuple changed.");
	assert.equal(["created", "lost_ack_recovered"].includes(lower(reconciliation.status)), true, "Applied reconciliation status changed.");
	assert.equal(lower(reconciliation.actionTaken), "created", "Applied reconciliation action changed.");
	if (target.provider === "trip") {
		assert.deepEqual(reconciliation.tripGrossRoundingCorrection, tripRoundingCorrection(target), "Applied Trip rounding-correction tuple changed.");
	} else {
		assert.equal(reconciliation.tripGrossRoundingCorrection == null, true, "An Agoda audit contains a Trip rounding marker.");
	}
	assert.equal(audit.orchestratorDecision?.usedAI, false, "Applied audit reports AI use.");
	assert.equal(audit.orchestratorDecision?.skipped, true, "Applied audit orchestrator marker changed.");
	assert.equal(audit.orchestratorDecision?.skipReason, "dated_authenticated_archive_recovery", "Applied audit orchestrator reason changed.");
	assert.equal(lower(audit.orchestratorDecision?.repairId), REPAIR_ID, "Applied audit orchestrator repair ID changed.");
	assert.equal(audit.orchestratorDecision?.policyDate, POLICY_DATE, "Applied audit orchestrator policy date changed.");
	assert.ok(dateIso(audit.processedAt), "Applied audit processing timestamp is missing.");
	const normalized = audit.normalizedReservation || {};
	assert.equal(lower(normalized.provider), target.provider, "Applied normalized provider changed.");
	assert.equal(normalizeConfirmation(normalized.confirmationNumber || normalized.reservationId), target.confirmationNumber, "Applied normalized confirmation changed.");
	assert.equal(clean(normalized.checkinDate), target.checkinDate, "Applied normalized check-in changed.");
	assert.equal(clean(normalized.checkoutDate), target.checkoutDate, "Applied normalized check-out changed.");
	assert.equal(Number(normalized.roomCount), target.roomCount, "Applied normalized room count changed.");
	assert.equal(Number(normalized.totalGuests), target.totalGuests, "Applied normalized guest count changed.");
	assert.equal(lower(normalized.source?.textHash), target.textHash, "Applied normalized source hash changed.");
	assert.equal(id(normalized.inboundEmailId), target.auditId, "Applied normalized archive link changed.");
	assert.equal(money(normalized.totalAmountSar), target.grossSar, "Applied normalized SAR gross changed.");
	assert.equal(money(normalized.totalPayoutSar), target.payoutSar, "Applied normalized SAR payout changed.");
	if (target.provider === "trip") {
		assertExactTripDatedRecoveryEvidence(
			target,
			normalized.datedRecoveryConversionEvidence,
			"Applied normalized Trip dated recovery evidence"
		);
		assert.equal(
			Boolean(
				normalized.currencyConversionEvidence ||
					normalized.paymentSummary?.currencyConversionEvidence
			),
			false,
			"Applied normalized Trip audit fabricated ordinary conversion evidence."
		);
	} else {
		assert.equal(
			normalized.datedRecoveryConversionEvidence == null,
			true,
			"An Agoda audit contains Trip dated recovery evidence."
		);
	}
}

function historicalArchiveConversionTuple(target, audit) {
	if (target.sourceCurrency === "SAR") return null;
	const stored = audit.normalizedReservation || {};
	const paymentSummary = stored.paymentSummary || {};
	assert.equal(money(audit.sourceAmount), target.sourceGross, "Archived top-level source gross changed.");
	assert.equal(clean(audit.sourceCurrency).toUpperCase(), target.sourceCurrency, "Archived top-level source currency changed.");
	assert.equal(money(audit.totalAmountSar), target.legacySkippedGrossSar, "Archived legacy gross changed.");
	assert.equal(Number(audit.exchangeRateToSar), target.exchangeRateToSar, "Archived top-level rate changed.");
	assert.equal(lower(audit.exchangeRateSource), target.archivedExchangeRateSource, "Archived top-level rate source changed.");
	assert.equal(money(stored.sourceAmount), target.sourceGross, "Archived normalized source gross changed.");
	assert.equal(money(paymentSummary.sourceTotalPayoutAmount), target.sourcePayout, "Archived normalized source payout changed.");
	assert.equal(clean(stored.sourceCurrency).toUpperCase(), target.sourceCurrency, "Archived normalized source currency changed.");
	assert.equal(Number(stored.exchangeRateToSar), target.exchangeRateToSar, "Archived normalized rate changed.");
	assert.equal(lower(stored.exchangeRateSource), target.archivedExchangeRateSource, "Archived normalized rate source changed.");
	assert.equal(dateIso(stored.amountConvertedAt), target.archivedAmountConvertedAt, "Archived conversion timestamp changed.");
	assert.equal(money(stored.totalAmountSar), target.legacySkippedGrossSar, "Archived normalized legacy gross changed.");
	assert.equal(money(stored.totalPayoutSar), target.legacySkippedPayoutSar, "Archived normalized legacy payout changed.");
	return {
		sourceCurrency: target.sourceCurrency,
		sourceGross: target.sourceGross,
		sourcePayout: target.sourcePayout,
		storedExchangeRateToSar: target.exchangeRateToSar,
		storedExchangeRateSource: target.archivedExchangeRateSource,
		amountConvertedAt: target.archivedAmountConvertedAt,
		sourceReceivedAt: target.sourceReceivedAt,
		legacyGrossSar: target.legacySkippedGrossSar,
		legacyPayoutSar: target.legacySkippedPayoutSar,
	};
}

async function freshNormalizedFromArchive(target, audit, dependencies = {}) {
	const parse = dependencies.extractNormalizedReservation || extractNormalizedReservation;
	let normalized = parse(emailFromAudit(audit));
	normalized.inboundEmailId = target.auditId;
	assert.equal(lower(normalized.provider), target.provider, "Fresh parser provider changed.");
	assert.equal(normalizeConfirmation(normalized.confirmationNumber || normalized.reservationId), target.confirmationNumber, "Fresh parser confirmation changed.");
	assert.equal(lower(normalized.intent), "new_reservation", "Fresh parser intent is not a new reservation.");
	assert.equal(lower(normalized.eventType), "new", "Fresh parser event is not a new reservation.");
	assert.equal(lower(normalized.statusToApply || "confirmed"), "confirmed", "Fresh parser lifecycle is not confirmed.");
	assert.equal(normalized.sourceSenderAuthenticated, true, "Fresh parser lost aligned sender authentication.");
	assert.equal(normalized.sourceSenderTrusted, true, "Fresh parser lost trusted sender status.");
	assert.equal(lower(normalized.trustedTransportProvider), target.provider, "Fresh trusted transport changed.");
	assert.equal(normalized.requiresManualReview, false, "Fresh parser still requires manual review.");
	assert.equal(normalized.blocksUnmappedReservationCreation, false, "Fresh parser still blocks safe reservation creation.");
	assert.equal(normalized.ambiguousMultiRoomEvidence === true, false, "Fresh parser still reports ambiguous multi-room evidence.");
	assert.deepEqual(normalized.genericRepeatedFactConflictFields || [], [], "Fresh parser reports repeated-fact conflicts.");
	assert.equal(clean(normalized.checkinDate), target.checkinDate, "Fresh check-in changed.");
	assert.equal(clean(normalized.checkoutDate), target.checkoutDate, "Fresh check-out changed.");
	assert.equal(Number(normalized.roomCount), target.roomCount, "Fresh room quantity changed.");
	assert.equal(Number(normalized.totalGuests), target.totalGuests, "Fresh aggregate guest count changed.");
	assert.equal(guestKeyHash(normalized.guestName), target.guestKeyHash, "Fresh primary guest identity changed.");
	assert.equal(lower(normalized.source?.textHash), target.textHash, "Fresh source-text hash changed.");
	assert.equal(dateIso(normalized.source?.receivedAt), target.sourceReceivedAt, "Fresh source timestamp changed.");
	for (const field of ["confirmationNumber", "guestName", "roomName", "checkinDate", "checkoutDate", "amount", "totalGuests"]) {
		assert.equal(normalized.sourcePresence?.[field], true, `${field} is no longer source-backed.`);
	}
	if (target.provider === "agoda") {
		assert.equal(clean(normalized.agodaPropertyId), target.propertyId, "Agoda Property ID changed.");
		assert.equal(normalized.sourcePresence?.agodaPropertyId, true, "Agoda Property ID is no longer source-backed.");
		assert.equal(normalized.agodaHomogeneousRoomQuantity, true, "Agoda room quantity is no longer homogeneous.");
		assert.equal(money(normalized.totalAmountSar), target.grossSar, "Agoda whole-booking gross changed.");
		assert.equal(money(normalized.totalPayoutSar), target.payoutSar, "Agoda whole-booking payout changed.");
	} else {
		const historicalArchiveTuple = historicalArchiveConversionTuple(target, audit);
		const buildBoundary =
			dependencies.buildDatedRecoveryConversionBoundary ||
			buildDatedRecoveryConversionBoundary;
		const applyBoundary =
			dependencies.applyDatedRecoveryConversionBoundary ||
			applyDatedRecoveryConversionBoundary;
		const boundary = buildBoundary(normalized, {
			emailHash: target.emailHash,
			historicalArchiveTuple,
		});
		normalized = applyBoundary(normalized, boundary);
		assert.equal(normalized.propertyConversionVerified, true, "Dated archive-tuple conversion was not revalidated.");
		assert.equal(normalized.datedRecoveryConversionEvidence?.trustedForOrdinaryAutomation, false, "Dated conversion was mislabeled as ordinary automation evidence.");
		assert.equal(normalized.datedRecoveryConversionEvidence?.networkUsed, false, "Dated conversion incorrectly records network use.");
		assertExactTripDatedRecoveryEvidence(
			target,
			normalized.datedRecoveryConversionEvidence,
			"Fresh normalized Trip dated recovery evidence"
		);
		assert.equal("currencyConversionEvidence" in normalized, false, "Dated recovery fabricated ordinary currency-conversion evidence.");
		assert.equal(Number(normalized.exchangeRateToSar), target.exchangeRateToSar, "Trip exchange rate changed.");
		assert.equal(money(normalized.totalAmountSar), target.grossSar, "Trip exact-decimal gross changed.");
		assert.equal(money(normalized.totalPayoutSar), target.payoutSar, "Trip exact-decimal payout changed.");
		assert.deepEqual((normalized.nightlyPricingSar || []).map((row) => money(row.clientAmountSar)), [120.45, 120.45, 131.93], "Trip nightly gross allocation changed.");
		assert.deepEqual((normalized.nightlyPricingSar || []).map((row) => money(row.payoutAmountSar)), [113.78, 113.78, 124.57], "Trip nightly payout allocation changed.");
	}
	const sourceGross = Number(normalized.sourceAmount ?? normalized.paymentSummary?.sourceTotalGuestPaymentAmount ?? normalized.amount);
	const sourcePayout = Number(normalized.paymentSummary?.sourceTotalPayoutAmount ?? normalized.sourcePayoutAmount);
	assert.equal(money(sourceGross), target.sourceGross, "Immutable source gross changed.");
	assert.equal(money(sourcePayout), target.sourcePayout, "Immutable source payout changed.");
	assert.equal(clean(normalized.sourceCurrency || normalized.paymentSummary?.sourceCurrency).toUpperCase(), target.sourceCurrency, "Immutable source currency changed.");
	return normalized;
}

function roomRows(document = {}) {
	return Array.isArray(document.pickedRoomsPricing) ? document.pickedRoomsPricing : [];
}

function matrix(document, field) {
	return roomRows(document).map((room) => (room.pricingByDay || []).map((day) => money(day[field])));
}

function expectedTripDatedRecoveryEvidence(target) {
	assert.equal(target?.provider, "trip", "Trip dated recovery evidence requires the Trip target.");
	return {
		version: 1,
		evidenceType: "dated_recovery_historical_archive_tuple",
		repairId: REPAIR_ID,
		policyDate: POLICY_DATE,
		provider: target.provider,
		confirmationNumber: target.confirmationNumber,
		inboundEmailId: target.auditId,
		emailHash: target.emailHash,
		textHash: target.textHash,
		historicalArchiveTuple: {
			sourceCurrency: target.sourceCurrency,
			sourceGross: target.sourceGross,
			sourcePayout: target.sourcePayout,
			storedExchangeRateToSar: target.exchangeRateToSar,
			storedExchangeRateSource: target.archivedExchangeRateSource,
			amountConvertedAt: target.archivedAmountConvertedAt,
			sourceReceivedAt: target.sourceReceivedAt,
			legacyGrossSar: target.legacySkippedGrossSar,
			legacyPayoutSar: target.legacySkippedPayoutSar,
		},
		deterministicOutput: {
			grossSar: target.grossSar,
			payoutSar: target.payoutSar,
			expenseSar: target.expenseSar,
			nightlyGrossSar: [120.45, 120.45, 131.93],
			nightlyPayoutSar: [113.78, 113.78, 124.57],
		},
		trustedForOrdinaryAutomation: false,
		networkUsed: false,
		tupleHash: TRIP_DATED_RECOVERY_TUPLE_HASH,
	};
}

function assertExactTripDatedRecoveryEvidence(target, evidence, label = "Trip dated recovery evidence") {
	const expected = expectedTripDatedRecoveryEvidence(target);
	assert.equal(
		datedRecoveryBoundaryHash(expected),
		TRIP_DATED_RECOVERY_TUPLE_HASH,
		"Compiled Trip dated recovery boundary no longer hashes to its pinned tuple."
	);
	assert.equal(
		clean(evidence?.tupleHash),
		TRIP_DATED_RECOVERY_TUPLE_HASH,
		`${label} tuple hash changed.`
	);
	assert.deepEqual(
		canonicalize(evidence),
		canonicalize(expected),
		`${label} boundary changed.`
	);
	return true;
}

function assertNoPhysicalRoomAssignments(document = {}) {
	const assignedRoomIds = (Array.isArray(document.roomId) ? document.roomId : [document.roomId])
		.map(id)
		.filter(Boolean);
	const assignedBeds = (Array.isArray(document.bedNumber) ? document.bedNumber : [document.bedNumber])
		.map(clean)
		.filter(Boolean);
	assert.deepEqual(assignedRoomIds, [], "Recovery must not assign physical PMS rooms.");
	assert.deepEqual(assignedBeds, [], "Recovery must not assign physical beds.");
	for (const room of [
		...(Array.isArray(document.pickedRoomsType) ? document.pickedRoomsType : []),
		...(Array.isArray(document.pickedRoomsPricing) ? document.pickedRoomsPricing : []),
	]) {
		for (const field of ["roomId", "room_id", "roomNumber", "room_number"]) {
			assert.equal(clean(room?.[field]), "", `Recovery must not set picked-room physical field ${field}.`);
		}
		for (const field of ["roomIds", "room_ids", "roomNumbers", "room_numbers"]) {
			assert.deepEqual(Array.isArray(room?.[field]) ? room[field] : [], [], `Recovery must not set picked-room physical field ${field}.`);
		}
	}
}

function assertExpectedReservationShape(target, document, { persisted = false } = {}) {
	assert.ok(document, "Expected reservation document is missing.");
	assert.equal(id(document.hotelId), HOTEL_ID, "Hotel mapping changed.");
	assert.equal(id(document.belongsTo), OWNER_ID, "Hotel owner mapping changed.");
	assert.equal(normalizeConfirmation(document.reservation_id), target.confirmationNumber, "Reservation source identity changed.");
	assert.equal(normalizeConfirmation(document.customer_details?.confirmation_number2), target.confirmationNumber, "Reservation customer confirmation changed.");
	assert.equal(normalizeConfirmation(document.supplierData?.suppliedBookingNo), target.confirmationNumber, "Reservation supplied booking number changed.");
	assert.equal(normalizeConfirmation(document.supplierData?.otaConfirmationNumber), target.confirmationNumber, "Reservation OTA confirmation changed.");
	assert.equal(normalizeConfirmation(document.supplierData?.platformConfirmationNumber), target.confirmationNumber, "Reservation platform confirmation changed.");
	assert.equal(lower(document.supplierData?.otaProvider), target.provider, "Reservation OTA provider changed.");
	assert.equal(id(document.supplierData?.otaInboundEmailId), target.auditId, "Reservation direct archive link changed.");
	assert.equal(lower(document.otaIdentityKey), buildOtaIdentityKey(target.provider, target.confirmationNumber), "Reservation OTA identity key changed.");
	assert.equal(lower(document.otaCrossTransportIdentityKey), target.provider === "trip" ? `trip:${target.confirmationNumber}` : "", "Reservation cross-transport identity key changed.");
	assert.equal(lower(document.state), "ota platform review", "Reservation state did not remain in OTA Platform Review.");
	assert.equal(lower(document.reservation_status), "ota platform review", "Reservation did not remain in OTA Platform Review.");
	assert.equal(lower(document.otaPlatformReview?.status), "pending", "OTA Platform Review is not pending.");
	assert.equal(clean(document.currency).toUpperCase(), "SAR", "Reservation property currency changed.");
	assert.equal(dateOnly(document.checkin_date), target.checkinDate, "Reservation check-in changed.");
	assert.equal(dateOnly(document.checkout_date), target.checkoutDate, "Reservation check-out changed.");
	assert.equal(Number(document.total_rooms), 2, "Reservation room quantity changed.");
	assert.equal(Number(document.total_guests), target.totalGuests, "Reservation aggregate guest count changed.");
	assert.deepEqual(canonicalize(document.pickedRoomsType || []), canonicalize(document.pickedRoomsPricing || []), "pickedRoomsType and pickedRoomsPricing diverged.");
	assert.equal(roomRows(document).length, 2, "Reservation must contain two separate room rows.");
	assert.deepEqual(roomRows(document).map((room) => Number(room.count)), [1, 1], "Each recovered room row must have count one.");
	const expectedDates = generateDateRange(target.checkinDate, target.checkoutDate);
	for (const room of roomRows(document)) {
		assert.equal(id(room.hotelRoomConfigId), target.roomConfigId, "Room config mapping changed.");
		assert.equal(clean(room.room_type), target.roomType, "Room type mapping changed.");
		assert.deepEqual((room.pricingByDay || []).map((day) => clean(day.date).slice(0, 10)), expectedDates, "A room row does not contain the complete stay.");
	}
	assert.deepEqual(matrix(document, "clientPrice"), target.expectedNightGross, "Per-room guest-gross allocation changed.");
	assert.deepEqual(matrix(document, "netAfterExpenses"), target.expectedNightPayout, "Per-room payout allocation changed.");
	assert.deepEqual(matrix(document, "rootPrice"), target.expectedNightRoot, "Per-room hotel-base allocation changed.");
	for (const field of ["price", "mainPrice", "totalPriceWithCommission"]) {
		assert.deepEqual(
			matrix(document, field),
			target.expectedNightGross,
			`Per-night guest-gross alias ${field} changed.`
		);
	}
	assert.deepEqual(
		matrix(document, "totalPriceWithoutCommission"),
		target.expectedNightRoot,
		"Per-night hotel-base alias totalPriceWithoutCommission changed."
	);
	assert.deepEqual(
		matrix(document, "netAfterOtaExpenses"),
		target.expectedNightPayout,
		"Per-night payout alias netAfterOtaExpenses changed."
	);
	const expectedNightExpense = target.expectedNightGross.map((room, roomIndex) =>
		room.map((gross, dayIndex) =>
			money(gross - target.expectedNightPayout[roomIndex][dayIndex])
		)
	);
	const expectedNightPlatformMargin = target.expectedNightPayout.map(
		(room, roomIndex) =>
			room.map((payout, dayIndex) =>
				money(payout - target.expectedNightRoot[roomIndex][dayIndex])
			)
	);
	assert.deepEqual(
		matrix(document, "otaExpenseAmount"),
		expectedNightExpense,
		"Per-night OTA expense allocation changed."
	);
	assert.deepEqual(
		matrix(document, "platformMargin"),
		expectedNightPlatformMargin,
		"Per-night platform-margin allocation changed."
	);
	assert.deepEqual(
		matrix(document, "commissionRate"),
		target.expectedNightGross.map((room) => room.map(() => 0)),
		"Per-night PMS commission-rate alias changed."
	);
	const days = roomRows(document).flatMap((room) => room.pricingByDay || []);
	assert.equal(money(days.reduce((sum, day) => sum + Number(day.clientPrice), 0)), target.grossSar, "Room rows do not sum to whole-booking gross.");
	assert.equal(money(days.reduce((sum, day) => sum + Number(day.netAfterExpenses), 0)), target.payoutSar, "Room rows do not sum to whole-booking payout.");
	assert.equal(money(days.reduce((sum, day) => sum + Number(day.rootPrice), 0)), target.rootSar, "Room rows do not sum to hotel base.");
	assert.equal(money(days.reduce((sum, day) => sum + Number(day.otaExpenseAmount), 0)), target.expenseSar, "Room rows do not sum to OTA expense.");
	roomRows(document).forEach((room, roomIndex) => {
		const expectedRoomGross = money(
			target.expectedNightGross[roomIndex].reduce((sum, value) => sum + value, 0)
		);
		const expectedRoomRoot = money(
			target.expectedNightRoot[roomIndex].reduce((sum, value) => sum + value, 0)
		);
		assert.equal(
			money(room.totalPriceWithCommission),
			expectedRoomGross,
			"Room-level guest-gross total changed."
		);
		assert.equal(
			money(room.hotelShouldGet),
			expectedRoomRoot,
			"Room-level hotel-base total changed."
		);
		assert.equal(
			money(room.chosenPrice),
			money(expectedRoomGross / expectedDates.length),
			"Room-level chosen-price alias changed."
		);
	});
	assert.equal(money(document.total_amount), target.grossSar, "Whole-booking total changed.");
	assert.equal(money(document.sub_total), target.rootSar, "Whole-booking hotel base changed.");
	assert.equal(money(document.paid_amount), target.grossSar, "Whole-booking paid amount alias changed.");
	assert.equal(money(document.paid_amount_breakdown?.paid_online_other_platforms), target.grossSar, "OTA-paid breakdown alias changed.");
	assert.equal(money(document.commission), 0, "PMS commission alias changed.");
	if (target.otaCommissionSar === null) {
		assert.equal(document.commission_ota == null, true, "Unproven OTA commission was materialized.");
	} else {
		assert.equal(money(document.commission_ota), target.otaCommissionSar, "Source-backed OTA commission changed.");
	}
	assert.equal(money(document.adminPricing?.clientTotal), target.grossSar, "Admin gross alias changed.");
	assert.equal(money(document.adminPricing?.rootTotal), target.rootSar, "Admin root alias changed.");
	assert.equal(money(document.adminPricing?.netAfterExpensesTotal), target.payoutSar, "Whole-booking payout summary changed.");
	assert.equal(money(document.adminPricing?.otaExpenseTotal), target.expenseSar, "Whole-booking OTA expense summary changed.");
	assert.equal(money(document.adminPricing?.platformMarginTotal), target.platformMarginSar, "Whole-booking platform margin changed.");
	assert.equal(money(document.ota_financial_summary?.clientTotal), target.grossSar, "Financial-summary gross alias changed.");
	assert.equal(money(document.ota_financial_summary?.hotelVisibleAmount), target.rootSar, "Financial-summary root alias changed.");
	assert.equal(money(document.ota_financial_summary?.netAfterExpenses), target.payoutSar, "Financial-summary payout alias changed.");
	assert.equal(money(document.ota_financial_summary?.netAfterOtaExpenses), target.payoutSar, "Financial-summary post-OTA payout alias changed.");
	assert.equal(money(document.ota_financial_summary?.otaExpenseTotal), target.expenseSar, "Financial-summary OTA expense alias changed.");
	assert.equal(money(document.ota_financial_summary?.platformProfit), target.platformMarginSar, "Financial-summary platform margin changed.");
	assert.equal(money(document.supplierData?.otaAmountSar), target.grossSar, "Supplier gross alias changed.");
	assert.equal(money(document.supplierData?.otaTotalPayoutSar), target.payoutSar, "Supplier payout alias changed.");
	assert.equal(money(document.supplierData?.otaExpenseTotalSar), target.expenseSar, "Supplier OTA expense alias changed.");
	assert.equal(money(document.supplierData?.otaPlatformMarginSar), target.platformMarginSar, "Supplier platform margin alias changed.");
	assert.equal(lower(document.supplierData?.otaRoomMatchType), target.expectedRoomMatchType, "Stored deterministic room-match type changed.");
	assert.equal(Number(document.supplierData?.otaRoomMatchScore), target.expectedRoomMatchScore, "Stored deterministic room-match score changed.");
	assert.equal(clean(document.supplierData?.otaRoomMatchedByModel), "", "AI room matching was used.");
	assert.equal(clean(document.supplierData?.otaRoomMatchReason), "", "AI room-match reasoning was stored.");
	assertNoPhysicalRoomAssignments(document);
	if (target.propertyId) {
		assert.equal(clean(document.supplierData?.agodaPropertyId), target.propertyId, "Agoda property audit ID changed.");
	}
	if (persisted) {
		const recovery = document.supplierData?.directOtaArchiveRecovery || {};
		assert.equal(lower(recovery.repairId), REPAIR_ID, "Reservation recovery provenance is missing.");
		assert.equal(recovery.policyDate, POLICY_DATE, "Reservation recovery policy date changed.");
		assert.equal(id(recovery.inboundEmailId), target.auditId, "Reservation recovery provenance points at another archive.");
		assert.equal(lower(recovery.provider), target.provider, "Reservation recovery provider changed.");
		assert.equal(normalizeConfirmation(recovery.confirmationNumber), target.confirmationNumber, "Reservation recovery confirmation changed.");
		assert.equal(lower(recovery.emailHash), target.emailHash, "Reservation recovery email hash changed.");
		assert.equal(lower(recovery.textHash), target.textHash, "Reservation recovery text hash changed.");
		assert.equal(recovery.ordinaryOtaReconciler, true, "Reservation recovery did not retain the ordinary-reconciler marker.");
		assert.equal(recovery.orderTakerNormalizationUsed, false, "Reservation recovery reports OrderTaker normalization.");
		assert.ok(dateIso(recovery.appliedAt), "Reservation recovery application timestamp is missing.");
		const recoveryAuditEntries = (document.reservationAuditLog || []).filter(
			(entry) => lower(entry?.repairId) === REPAIR_ID && id(entry?.inboundEmailId) === target.auditId
		);
		assert.equal(recoveryAuditEntries.length, 1, "Reservation recovery audit entry is not unique.");
		assert.equal(lower(recoveryAuditEntries[0].provider), target.provider, "Reservation recovery audit provider changed.");
		assert.equal(normalizeConfirmation(recoveryAuditEntries[0].confirmationNumber), target.confirmationNumber, "Reservation recovery audit confirmation changed.");
		assert.equal(document.availabilitySnapshot?.captured, true, "Inventory availability snapshot was not retained.");
		if (target.expectedOverbooked) {
			assert.equal(document.availabilitySnapshot?.overbooked, true, "Known overbooking warning was not retained.");
			assert.ok(Number(document.availabilitySnapshot?.issueCount) > 0, "Known overbooking issues were not retained.");
		}
		if (target.provider === "trip") {
			const evidence =
				document.supplierData?.datedRecoveryConversionEvidence;
			assertExactTripDatedRecoveryEvidence(
				target,
				evidence,
				"Persisted Trip dated recovery evidence"
			);
			assert.equal(
				Boolean(
					document.supplierData?.currencyConversionEvidence ||
						document.supplierData?.otaPaymentSummary
							?.currencyConversionEvidence
				),
				false,
				"Trip dated recovery fabricated ordinary conversion evidence."
			);
		} else {
			assert.equal(
				document.supplierData?.datedRecoveryConversionEvidence == null,
				true,
				"An Agoda reservation contains Trip dated recovery evidence."
			);
		}
	}
	return true;
}

async function resolveExpectedDocument(target, normalized, dependencies = {}) {
	const resolveHotelFn = dependencies.resolveHotel || resolveHotel;
	const validateInventory = dependencies.validateReservationInventoryForCreate || validateReservationInventoryForCreate;
	const hotel = await resolveHotelFn(normalized);
	assert.ok(hotel, "Ordinary OTA hotel resolution failed.");
	assert.equal(id(hotel._id), HOTEL_ID, "Ordinary OTA hotel resolution changed.");
	assert.equal(id(hotel.belongsTo), OWNER_ID, "Resolved hotel owner changed.");
	assert.equal(hotel.activateHotel, true, "Resolved hotel is inactive.");
	assert.equal(hotel.xHotelProActive, true, "Resolved hotel is not active in xHotelPro.");
	assert.equal(clean(hotel.currency).toUpperCase(), "SAR", "Resolved hotel currency changed.");
	const roomMatch = resolveRoomMatch(hotel, normalized.roomName, { totalGuests: normalized.totalGuests, normalized });
	assert.ok(roomMatch.roomDetails, "Ordinary OTA room resolution failed.");
	assert.equal(id(roomMatch.roomDetails._id), target.roomConfigId, "Ordinary OTA room mapping changed.");
	assert.equal(clean(roomMatch.roomDetails.roomType), target.roomType, "Resolved room type changed.");
	assert.notEqual(roomMatch.roomDetails.activeRoom, false, "Resolved room is inactive.");
	assert.equal(lower(roomMatch.matchType), target.expectedRoomMatchType, "Deterministic room-match rule changed.");
	assert.equal(Number(roomMatch.score), target.expectedRoomMatchScore, "Deterministic room-match score changed.");
	assert.equal(roomMatch.aiFallbackAllowed, false, "Room mapping unexpectedly permits AI fallback.");
	assert.equal(Boolean(roomMatch.aiRoomMatch), false, "Room mapping unexpectedly used AI evidence.");
	const built = buildReservationDocument(normalized, hotel, { roomMatch });
	assert.equal(built.ok, true, built.error || "Ordinary OTA reservation builder failed.");
	built.document.otaIdentityKey = buildOtaIdentityKey(target.provider, target.confirmationNumber);
	built.document.otaCrossTransportIdentityKey = buildOtaCrossTransportIdentityKey(
		normalized,
		target.confirmationNumber
	);
	built.document.supplierData = { ...(built.document.supplierData || {}), otaInboundEmailId: target.auditId };
	assertExpectedReservationShape(target, built.document);
	const inventory = await validateInventory(built.document, { allowOverbook: true });
	assert.equal(inventory.allowed, true, "Ordinary inventory validation did not preserve overbook-as-warning policy.");
	if (target.expectedOverbooked) {
		assert.equal(inventory.availabilitySnapshot?.overbooked, true, "Known overbooking was not detected at preflight.");
		assert.ok(Number(inventory.availabilitySnapshot?.issueCount) > 0, "Known overbooking lacks issue evidence.");
	}
	return { hotel, roomMatch, document: built.document, inventory };
}

function confirmationValues(target) {
	const value = target.confirmationNumber;
	return Array.from(new Set([value, value.toLowerCase(), value.toUpperCase(), `${target.provider}:${value}`]));
}

function broadConfirmationLookup(target) {
	const values = confirmationValues(target);
	return {
		$or: [
			{ otaIdentityKey: { $in: values } },
			{ otaCrossTransportIdentityKey: { $in: values } },
			{ reservation_id: { $in: values } },
			{ confirmation_number: { $in: values } },
			{ pms_number: { $in: values } },
			{ hr_number: { $in: values } },
			{ "customer_details.confirmation_number2": { $in: values } },
			{ "customer_details.confirmationNumber": { $in: values } },
			{ "customer_details.confirmationNumber2": { $in: values } },
			{ "supplierData.suppliedBookingNo": { $in: values } },
			{ "supplierData.supplierBookingNo": { $in: values } },
			{ "supplierData.supplierBookingNumber": { $in: values } },
			{ "supplierData.otaConfirmationNumber": { $in: values } },
			{ "supplierData.platformConfirmationNumber": { $in: values } },
			{ "supplierData.pmsConfirmationNumber": { $in: values } },
			{ "otaPlatformReview.confirmationNumber": { $in: values } },
			{ "reservationAuditLog.confirmationNumber": { $in: values } },
			{ "reservationAuditLog.reservationId": { $in: values } },
		],
	};
}

function dayBounds(ymd) {
	const start = new Date(`${ymd}T00:00:00.000Z`);
	return { $gte: start, $lt: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

function effectiveRoomCount(reservation = {}) {
	const explicit = Number(reservation.total_rooms || 0);
	if (Number.isFinite(explicit) && explicit > 0) return explicit;
	const rows = Array.isArray(reservation.pickedRoomsPricing) && reservation.pickedRoomsPricing.length
		? reservation.pickedRoomsPricing
		: Array.isArray(reservation.pickedRoomsType) ? reservation.pickedRoomsType : [];
	return rows.reduce((sum, row) => sum + Math.max(1, Number(row?.count || 1)), 0);
}

function reservationRoomMatches(target, reservation = {}) {
	const rows = [
		...(Array.isArray(reservation.pickedRoomsPricing) ? reservation.pickedRoomsPricing : []),
		...(Array.isArray(reservation.pickedRoomsType) ? reservation.pickedRoomsType : []),
	];
	return rows.some((row) =>
		id(row?.hotelRoomConfigId) === target.roomConfigId ||
		normalizeComparable(row?.room_type) === normalizeComparable(target.roomType)
	);
}

function plausibleManualCandidates(target, reservations = []) {
	return reservations.flatMap((reservation) => {
		if (guestKeyHash(reservation.customer_details?.name) !== target.guestKeyHash) return [];
		const roomCountMatches = effectiveRoomCount(reservation) === target.roomCount;
		const roomMatches = reservationRoomMatches(target, reservation);
		if (!roomCountMatches && !roomMatches) return [];
		return [{
			reservationId: id(reservation._id),
			reasons: ["same_hotel", "same_stay", "same_normalized_primary_guest", ...(roomCountMatches ? ["same_room_count"] : []), ...(roomMatches ? ["same_room_mapping"] : [])],
		}];
	});
}

function recoveryMarkerMatches(target, reservation = {}) {
	const marker = reservation.supplierData?.directOtaArchiveRecovery || {};
	return lower(marker.repairId) === REPAIR_ID && id(marker.inboundEmailId) === target.auditId && lower(marker.provider) === target.provider && normalizeConfirmation(marker.confirmationNumber) === target.confirmationNumber && marker.emailHash === target.emailHash && marker.textHash === target.textHash;
}

function uniqueReservations(reservations = []) {
	return Array.from(new Map(reservations.map((reservation) => [id(reservation._id), reservation])).values());
}

// This projection is also the evidence used by lost-ack adoption and the
// post-insert assertion. Keep every field inspected by
// assertExpectedReservationShape: omitting one can make a correct persisted
// value look absent (or, for a zero-like assertion, hide an unsafe value).
const RECOVERY_RESERVATION_EVIDENCE_SELECT = [
	"_id",
	"hotelId",
	"belongsTo",
	"reservation_id",
	"confirmation_number",
	"pms_number",
	"hr_number",
	"otaIdentityKey",
	"otaCrossTransportIdentityKey",
	"reservation_status",
	"state",
	"currency",
	"checkin_date",
	"checkout_date",
	"total_rooms",
	"total_guests",
	"total_amount",
	"sub_total",
	"paid_amount",
	"paid_amount_breakdown",
	"commission",
	"commission_ota",
	"roomId",
	"bedNumber",
	"pickedRoomsType",
	"pickedRoomsPricing",
	"adminPricing",
	"ota_financial_summary",
	"availabilitySnapshot",
	"customer_details.name",
	"customer_details.confirmation_number2",
	"supplierData",
	"otaPlatformReview",
	"reservationAuditLog",
].join(" ");

async function loadReservationEvidence(target, dependencies = {}) {
	const ReservationModel = dependencies.Reservations || Reservations;
	const select = RECOVERY_RESERVATION_EVIDENCE_SELECT;
	const providerLookup = buildOtaConfirmationLookup(target.confirmationNumber, target.provider);
	const [providerMatches, broadMatches, stayMatches] = await Promise.all([
		ReservationModel.find(providerLookup).select(select).lean().exec(),
		ReservationModel.find(broadConfirmationLookup(target)).select(select).lean().exec(),
		ReservationModel.find({ hotelId: HOTEL_ID, checkin_date: dayBounds(target.checkinDate), checkout_date: dayBounds(target.checkoutDate) }).select(select).lean().exec(),
	]);
	const exact = uniqueReservations([...providerMatches, ...broadMatches]);
	const plausible = plausibleManualCandidates(target, stayMatches.filter((candidate) => !exact.some((match) => id(match._id) === id(candidate._id))));
	const recovered = exact.filter((reservation) => recoveryMarkerMatches(target, reservation));
	return {
		exact,
		providerMatches: uniqueReservations(providerMatches),
		broadMatches: uniqueReservations(broadMatches),
		plausible,
		recovered,
		safeSummary: {
			exactReservationIds: exact.map((item) => id(item._id)).sort(),
			providerReservationIds: providerMatches.map((item) => id(item._id)).sort(),
			plausible,
			recoveredReservationIds: recovered.map((item) => id(item._id)).sort(),
		},
	};
}

function laterAuditLookup(target) {
	const values = confirmationValues(target);
	return {
		_id: { $ne: new mongoose.Types.ObjectId(target.auditId) },
		receivedAt: { $gt: new Date(target.sourceReceivedAt) },
		$or: [
			{ confirmationNumber: { $in: values } },
			{ "normalizedReservation.confirmationNumber": { $in: values } },
			{ "normalizedReservation.reservationId": { $in: values } },
			{ "reconciliation.confirmationNumber": { $in: values } },
		],
	};
}

function terminalLifecycle(normalized = {}) {
	const values = [normalized.eventType, normalized.statusToApply, normalized.state, normalized.intent].map(lower);
	return values.some((value) => ["cancelled", "canceled", "no_show", "no-show", "noshow"].includes(value));
}

function auditFingerprint(audit = {}) {
	return {
		auditId: id(audit._id),
		provider: lower(audit.provider),
		intent: lower(audit.intent),
		eventType: lower(audit.eventType),
		processingStatus: lower(audit.processingStatus),
		receivedAt: dateIso(audit.receivedAt),
		emailHash: lower(audit.emailHash),
		textHash: lower(audit.textHash),
		reservationMongoId: id(audit.reservationMongoId),
	};
}

async function loadLaterAuditEvidence(target, dependencies = {}) {
	const Model = dependencies.InboundEmail || InboundEmail;
	const audits = await Model.find(laterAuditLookup(target)).sort({ receivedAt: 1, _id: 1 }).lean().exec();
	const terminal = [];
	for (const audit of audits) {
		const stored = audit.normalizedReservation || {};
		let fresh = {};
		try {
			fresh = extractNormalizedReservation(emailFromAudit(audit));
		} catch (_error) {
			fresh = {};
		}
		if (terminalLifecycle(stored) || terminalLifecycle(fresh)) terminal.push(id(audit._id));
	}
	return { terminal, fingerprints: audits.map(auditFingerprint) };
}

async function loadDormantHotelRunnerState(target, db = mongoose.connection.db) {
	assert.ok(db, "Mongo database handle is unavailable.");
	const values = confirmationValues(target);
	const eventProjection = {
		_id: 1,
		hotelId: 1,
		eventKey: 1,
		messageUid: 1,
		payloadHash: 1,
		canonicalHash: 1,
		source: 1,
		hotelRunnerReservationId: 1,
		hrNumber: 1,
		providerNumber: 1,
		channel: 1,
		state: 1,
		modified: 1,
		sourceUpdatedAt: 1,
		status: 1,
		attempts: 1,
		finalRecoveryAttempted: 1,
		integrityReason: 1,
		integrityConflict: 1,
		integrityConflictCount: 1,
		errorCode: 1,
		errorMessage: 1,
		reservationMongoId: 1,
		mirrorId: 1,
	};
	const mirrorProjection = {
		_id: 1,
		hotelId: 1,
		hrIdFingerprint: 1,
		hotelRunnerReservationId: 1,
		hrNumber: 1,
		providerNumber: 1,
		hrNumberAliases: 1,
		providerNumberAliases: 1,
		channel: 1,
		channelDisplay: 1,
		sourceDisplay: 1,
		state: 1,
		modified: 1,
		observedSourceUpdatedAt: 1,
		observedCanonicalHash: 1,
		lastMessageUid: 1,
		projectionStatus: 1,
		projectionVersion: 1,
		identityConflict: 1,
		reservationMongoId: 1,
		appliedSourceUpdatedAt: 1,
		appliedCanonicalHash: 1,
		linkMethod: 1,
		linkedAt: 1,
		linkEvidence: 1,
	};
	const [fallbackJobs, outboxes, events, mirrors] = await Promise.all([
		db.collection("hotelrunnerotafallbackjobs").find({ $or: [{ confirmationNumber: { $in: values } }, { identityKey: { $in: values } }, { inboundEmailId: new mongoose.Types.ObjectId(target.auditId) }] }, { projection: { _id: 1 } }).toArray(),
		db.collection("hotelrunnerfallbacknotificationoutboxes").find({ $or: [{ confirmationNumber: { $in: values } }, { inboundEmailId: new mongoose.Types.ObjectId(target.auditId) }] }, { projection: { _id: 1 } }).toArray(),
		db.collection("hotelrunnerevents").find({ $or: [{ hotelRunnerReservationId: { $in: values } }, { hrNumber: { $in: values } }, { providerNumber: { $in: values } }] }, { projection: eventProjection }).toArray(),
		db.collection("hotelrunnerreservations").find({ $or: [{ hotelRunnerReservationId: { $in: values } }, { hrNumber: { $in: values } }, { providerNumber: { $in: values } }, { hrNumberAliases: { $in: values } }, { providerNumberAliases: { $in: values } }] }, { projection: mirrorProjection }).toArray(),
	]);
	const eventFingerprints = events.map((event) => ({
		id: id(event._id),
		hotelId: id(event.hotelId),
		eventKey: lower(event.eventKey),
		messageUid: clean(event.messageUid),
		payloadHash: lower(event.payloadHash),
		canonicalHash: lower(event.canonicalHash),
		source: lower(event.source),
		hotelRunnerReservationId: clean(event.hotelRunnerReservationId),
		hrNumber: clean(event.hrNumber),
		providerNumber: clean(event.providerNumber),
		channel: lower(event.channel),
		state: lower(event.state),
		modified: event.modified === true,
		sourceUpdatedAt: dateIso(event.sourceUpdatedAt),
		status: lower(event.status),
		attempts: Number(event.attempts || 0),
		finalRecoveryAttempted: event.finalRecoveryAttempted === true,
		integrityReason: clean(event.integrityReason),
		integrityConflict: event.integrityConflict === true,
		integrityConflictCount: Number(event.integrityConflictCount || 0),
		errorCode: clean(event.errorCode),
		errorMessageHash: sha256(clean(event.errorMessage)),
		reservationMongoId: id(event.reservationMongoId),
		mirrorId: id(event.mirrorId),
	})).sort((left, right) => left.id.localeCompare(right.id));
	const mirrorFingerprints = mirrors.map((mirror) => ({
		id: id(mirror._id),
		hotelId: id(mirror.hotelId),
		hrIdFingerprint: lower(mirror.hrIdFingerprint),
		hotelRunnerReservationId: clean(mirror.hotelRunnerReservationId),
		hrNumber: clean(mirror.hrNumber),
		providerNumber: clean(mirror.providerNumber),
		hrNumberAliases: (mirror.hrNumberAliases || []).map(clean),
		providerNumberAliases: (mirror.providerNumberAliases || []).map(clean),
		channel: lower(mirror.channel),
		channelDisplay: clean(mirror.channelDisplay),
		sourceDisplay: clean(mirror.sourceDisplay),
		state: lower(mirror.state),
		modified: mirror.modified === true,
		observedSourceUpdatedAt: dateIso(mirror.observedSourceUpdatedAt),
		observedCanonicalHash: lower(mirror.observedCanonicalHash),
		lastMessageUid: clean(mirror.lastMessageUid),
		projectionStatus: lower(mirror.projectionStatus),
		projectionVersion: Number(mirror.projectionVersion || 0),
		identityConflict: mirror.identityConflict === true,
		reservationMongoId: id(mirror.reservationMongoId),
		appliedSourceUpdatedAt: dateIso(mirror.appliedSourceUpdatedAt),
		appliedCanonicalHash: lower(mirror.appliedCanonicalHash),
		linkMethod: lower(mirror.linkMethod),
		linkedAt: dateIso(mirror.linkedAt),
		linkEvidenceKeys: Object.keys(mirror.linkEvidence || {}).sort(),
	})).sort((left, right) => left.id.localeCompare(right.id));
	return {
		fallbackJobIds: fallbackJobs.map((item) => id(item._id)).sort(),
		outboxIds: outboxes.map((item) => id(item._id)).sort(),
		events: eventFingerprints,
		mirrors: mirrorFingerprints,
	};
}

function assertDormantHotelRunnerState(target, state) {
	for (const key of ["fallbackJobIds", "outboxIds"]) {
		if (state[key].length) {
			fail("RECOVERY_HOTELRUNNER_STATE_PRESENT", `Unexpected dormant HotelRunner ${key} state exists.`, { key, ids: state[key] });
		}
	}
	const expected = target.expectedDormantHotelRunnerState;
	const expectedEvents = expected ? [expected.event] : [];
	const expectedMirrors = expected ? [expected.mirror] : [];
	if (!isDeepStrictEqual(state.events, expectedEvents) || !isDeepStrictEqual(state.mirrors, expectedMirrors)) {
		fail(
			"RECOVERY_HOTELRUNNER_STATE_CHANGED",
			"Dormant HotelRunner evidence changed from the exact dated allowlist; recovery stopped.",
			{ target: `${target.provider}:${target.confirmationNumber}`, expectedEvents, expectedMirrors, observedEvents: state.events, observedMirrors: state.mirrors }
		);
	}
	return true;
}

function assertRequiredIndexes(reservationIndexes = [], inboundIndexes = []) {
	const ota = reservationIndexes.find((index) => index.name === "uniq_ota_identity_key");
	assert.ok(ota, "Unique OTA identity index is missing.");
	assert.equal(ota.unique, true, "OTA identity index is not unique.");
	assert.deepEqual(ota.key, { otaIdentityKey: 1 }, "OTA identity index key changed.");
	assert.deepEqual(ota.partialFilterExpression, { otaIdentityKey: { $type: "string", $gt: "" } }, "OTA identity index scope changed.");
	const crossTransport = reservationIndexes.find((index) => index.name === "uniq_ota_cross_transport_identity_key");
	assert.ok(crossTransport, "Unique OTA cross-transport identity index is missing.");
	assert.equal(crossTransport.unique, true, "OTA cross-transport identity index is not unique.");
	assert.deepEqual(crossTransport.key, { otaCrossTransportIdentityKey: 1 }, "OTA cross-transport identity index key changed.");
	assert.deepEqual(crossTransport.partialFilterExpression, { otaCrossTransportIdentityKey: { $type: "string", $gt: "" } }, "OTA cross-transport identity index scope changed.");
	const inbound = inboundIndexes.find((index) => index.name === "uniq_inbound_email_dedupe_key");
	assert.ok(inbound, "Unique inbound-email dedupe index is missing.");
	assert.equal(inbound.unique, true, "Inbound-email dedupe index is not unique.");
	assert.deepEqual(inbound.key, { dedupeKey: 1 }, "Inbound-email dedupe index key changed.");
	assert.deepEqual(inbound.partialFilterExpression, { dedupeKey: { $type: "string", $gt: "" } }, "Inbound-email dedupe index scope changed.");
	return true;
}

function canonicalize(value) {
	if (value === null || value === undefined) return value ?? null;
	if (value instanceof Date) return value.toISOString();
	if (Array.isArray(value)) return value.map(canonicalize);
	if (typeof value === "object") {
		if (typeof value.toHexString === "function") return lower(value.toHexString());
		return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
	}
	return value;
}

function hashObject(value) {
	return sha256(JSON.stringify(canonicalize(value)));
}

function canonicalInventoryEvidence(value, key = "") {
	// `capturedAt` is assigned at reservation insertion time. Every other
	// inventory field—including stay dates, daily capacity/reserved values,
	// issue codes/details, warnings, and messages—is proof-bound exactly.
	if (key === "capturedAt") return undefined;
	if (value === null || value === undefined) return value ?? null;
	if (value instanceof Date) return value.toISOString();
	if (Array.isArray(value)) {
		return value.map((item) => canonicalInventoryEvidence(item));
	}
	if (typeof value === "object") {
		if (typeof value.toHexString === "function") return lower(value.toHexString());
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.flatMap((childKey) => {
					const child = canonicalInventoryEvidence(value[childKey], childKey);
					return child === undefined ? [] : [[childKey, child]];
				})
		);
	}
	return value;
}

function inventoryFingerprint(inventory = {}) {
	return canonicalInventoryEvidence(inventory);
}

function normalizedFingerprint(target, normalized) {
	return {
		provider: lower(normalized.provider),
		confirmationNumber: normalizeConfirmation(normalized.confirmationNumber),
		textHash: lower(normalized.source?.textHash),
		sourceReceivedAt: dateIso(normalized.source?.receivedAt),
		checkinDate: normalized.checkinDate,
		checkoutDate: normalized.checkoutDate,
		roomCount: Number(normalized.roomCount),
		totalGuests: Number(normalized.totalGuests),
		guestKeyHash: guestKeyHash(normalized.guestName),
		roomNameHash: sha256(normalizeComparable(normalized.roomName)),
		propertyId: clean(normalized.agodaPropertyId),
		sourceCurrency: clean(normalized.sourceCurrency).toUpperCase(),
		sourceGross: money(normalized.sourceAmount ?? normalized.paymentSummary?.sourceTotalGuestPaymentAmount),
		sourcePayout: money(normalized.paymentSummary?.sourceTotalPayoutAmount),
		grossSar: money(normalized.totalAmountSar),
		payoutSar: money(normalized.totalPayoutSar),
		exchangeRateToSar: Number(normalized.exchangeRateToSar || 0),
		datedRecoveryTupleHash: lower(
			normalized.datedRecoveryConversionEvidence?.tupleHash
		),
		trustedForOrdinaryAutomation:
			normalized.datedRecoveryConversionEvidence
				?.trustedForOrdinaryAutomation ?? null,
		networkUsed:
			normalized.datedRecoveryConversionEvidence?.networkUsed ?? null,
		expectedGrossSar: target.grossSar,
	};
}

function scopeBasis(scope) {
	const { target, audit, normalized, resolved, reservationEvidence, laterAuditEvidence, dormantHotelRunnerState, action } = scope;
	return {
		provider: target.provider,
		confirmationNumber: target.confirmationNumber,
		auditId: target.auditId,
		audit: {
			emailHash: audit.emailHash,
			textHash: audit.textHash,
			messageIdHash: sha256(audit.messageId || ""),
			dedupeKeyHash: sha256(audit.dedupeKey || ""),
			processingStatus: lower(audit.processingStatus),
			skipReason: lower(audit.skipReason),
			reservationMongoId: id(audit.reservationMongoId),
			repairId: lower(audit.reconciliation?.repairId),
			updatedAt: dateIso(audit.updatedAt),
			version: Number(audit.__v),
		},
		normalized: normalizedFingerprint(target, normalized),
		mapping: {
			hotelId: id(resolved.hotel._id),
			ownerId: id(resolved.hotel.belongsTo),
			roomConfigId: id(resolved.roomMatch.roomDetails?._id),
			roomType: clean(resolved.roomMatch.roomDetails?.roomType),
			matchType: lower(resolved.roomMatch.matchType),
			matchScore: Number(resolved.roomMatch.score || 0),
		},
		commercial: {
			grossSar: target.grossSar,
			payoutSar: target.payoutSar,
			expenseSar: target.expenseSar,
			rootSar: target.rootSar,
			platformMarginSar: target.platformMarginSar,
			nightlyGross: target.expectedNightGross,
			nightlyPayout: target.expectedNightPayout,
			nightlyRoot: target.expectedNightRoot,
		},
		inventory: inventoryFingerprint(resolved.inventory),
		reservations: reservationEvidence.safeSummary,
		laterAudits: laterAuditEvidence.fingerprints,
		laterTerminalAuditIds: laterAuditEvidence.terminal,
		dormantHotelRunnerState,
		action,
	};
}

async function loadTargetScope(target, dependencies = {}) {
	const InboundModel = dependencies.InboundEmail || InboundEmail;
	const audit = await InboundModel.findById(target.auditId).lean().exec();
	assertArchiveImmutable(target, audit);
	const normalized = await freshNormalizedFromArchive(target, audit, dependencies);
	const resolved = await resolveExpectedDocument(target, normalized, dependencies);
	const [reservationEvidence, laterAuditEvidence, dormantHotelRunnerState] = await Promise.all([
		loadReservationEvidence(target, dependencies),
		loadLaterAuditEvidence(target, dependencies),
		loadDormantHotelRunnerState(target, dependencies.db || mongoose.connection.db),
	]);
	if (laterAuditEvidence.terminal.length) {
		fail("RECOVERY_LATER_TERMINAL_EVENT", "A later authenticated terminal lifecycle archive exists; recovery stopped.", { auditId: target.auditId, laterTerminalAuditIds: laterAuditEvidence.terminal });
	}
	assertDormantHotelRunnerState(target, dormantHotelRunnerState);
	if (reservationEvidence.plausible.length) {
		fail("RECOVERY_PLAUSIBLE_MANUAL_DUPLICATE", "A plausible manual/OrderTaker reservation exists; recovery stopped for review.", { auditId: target.auditId, candidates: reservationEvidence.plausible });
	}
	const appliedAudit = lower(audit.reconciliation?.repairId) === REPAIR_ID;
	let action = "create_via_ordinary_ota_reconciler";
	if (appliedAudit) {
		assertAppliedAuditState(target, audit);
		assert.equal(reservationEvidence.exact.length, 1, "Applied recovery no longer has exactly one reservation.");
		assert.equal(reservationEvidence.recovered.length, 1, "Applied recovery provenance no longer has exactly one reservation.");
		assert.equal(id(audit.reservationMongoId), id(reservationEvidence.recovered[0]._id), "Applied audit links another reservation.");
		assertExpectedReservationShape(target, reservationEvidence.recovered[0], { persisted: true });
		action = "already_applied_noop";
	} else {
		assertOriginalAuditState(target, audit);
		if (reservationEvidence.exact.length === 0) {
			action = "create_via_ordinary_ota_reconciler";
		} else if (reservationEvidence.exact.length === 1 && reservationEvidence.recovered.length === 1) {
			assertExpectedReservationShape(target, reservationEvidence.recovered[0], { persisted: true });
			action = "finalize_lost_ack_only";
		} else {
			fail("RECOVERY_RESERVATION_IDENTITY_PRESENT", "A reservation already owns this external identity without exact recovery provenance; recovery stopped.", { auditId: target.auditId, evidence: reservationEvidence.safeSummary });
		}
	}
	return { target, audit, normalized, resolved, reservationEvidence, laterAuditEvidence, dormantHotelRunnerState, action };
}

async function buildPlan(plannedAt = new Date(), dependencies = {}) {
	assertHotelRunnerDisabled(dependencies.env || process.env);
	assertNoForbiddenHotelRunnerRuntimeModules();
	const ReservationModel = dependencies.Reservations || Reservations;
	const InboundModel = dependencies.InboundEmail || InboundEmail;
	const [reservationIndexes, inboundIndexes] = await Promise.all([
		ReservationModel.collection.indexes(),
		InboundModel.collection.indexes(),
	]);
	assertRequiredIndexes(reservationIndexes, inboundIndexes);
	const scopes = [];
	for (const target of TARGETS) scopes.push(await loadTargetScope(target, dependencies));
	const basis = {
		policyDate: POLICY_DATE,
		repairId: REPAIR_ID,
		plannedAt: dateIso(plannedAt),
		targetCount: TARGETS.length,
		targets: scopes.map(scopeBasis),
		indexProof: {
			reservation: reservationIndexes.find((item) => item.name === "uniq_ota_identity_key"),
			crossTransportReservation: reservationIndexes.find((item) => item.name === "uniq_ota_cross_transport_identity_key"),
			inbound: inboundIndexes.find((item) => item.name === "uniq_inbound_email_dedupe_key"),
		},
		hotelRunnerGates: Object.fromEntries(HOTELRUNNER_DISABLED_GATES.map((key) => [key, lower((dependencies.env || process.env)[key])])),
	};
	return { plannedAt: new Date(plannedAt), planHash: hashObject(basis), basis, scopes };
}

function proofToken(plan) {
	return `${new Date(plan.plannedAt).getTime()}.${plan.planHash}`;
}

function stampRecoveryProvenance(target, reservationData, plannedAt) {
	reservationData.supplierData = {
		...(reservationData.supplierData || {}),
		directOtaArchiveRecovery: {
			repairId: REPAIR_ID,
			policyDate: POLICY_DATE,
			inboundEmailId: target.auditId,
			provider: target.provider,
			confirmationNumber: target.confirmationNumber,
			emailHash: target.emailHash,
			textHash: target.textHash,
			appliedAt: new Date(plannedAt),
			ordinaryOtaReconciler: true,
			orderTakerNormalizationUsed: false,
		},
	};
	const existing = Array.isArray(reservationData.reservationAuditLog) ? reservationData.reservationAuditLog : [];
	if (!existing.some((entry) => lower(entry?.repairId) === REPAIR_ID && id(entry?.inboundEmailId) === target.auditId)) {
		reservationData.reservationAuditLog = [...existing, {
			at: new Date(plannedAt),
			action: "recovered-authenticated-direct-ota-archive",
			repairId: REPAIR_ID,
			inboundEmailId: target.auditId,
			provider: target.provider,
			confirmationNumber: target.confirmationNumber,
			note: "Dated proof-gated recovery through the ordinary OTA reconciler; retained in OTA Platform Review.",
		}];
	}
	return reservationData;
}

async function makeLastMomentCreateGuard(scope, plan, dependencies = {}) {
	const { target } = scope;
	return async ({ reservationData, inventoryValidation, mapped }) => {
		assertHotelRunnerDisabled(dependencies.env || process.env);
		assertNoForbiddenHotelRunnerRuntimeModules();
		assert.equal(mapped, true, "Recovery refuses an unmapped insertion.");
		assertExpectedReservationShape(target, reservationData);
		assert.equal(inventoryValidation?.allowed, true, "Last-moment inventory validation changed policy.");
		assert.deepEqual(
			inventoryFingerprint(inventoryValidation),
			inventoryFingerprint(scope.resolved.inventory),
			"Inventory evidence changed after the proof-bound dry run."
		);
		assert.equal(reservationData.availabilitySnapshot?.captured, true, "Last-moment inventory snapshot is missing.");
		if (target.expectedOverbooked) {
			assert.equal(reservationData.availabilitySnapshot?.overbooked, true, "Known last-moment overbooking warning disappeared.");
			assert.ok(Number(reservationData.availabilitySnapshot?.issueCount) > 0, "Known last-moment overbooking issues disappeared.");
		}
		const audit = await (dependencies.InboundEmail || InboundEmail).findById(target.auditId).lean().exec();
		assertArchiveImmutable(target, audit);
		assertOriginalAuditState(target, audit);
		const ReservationModel = dependencies.Reservations || Reservations;
		const InboundModel = dependencies.InboundEmail || InboundEmail;
		const [reservationEvidence, later, dormant, reservationIndexes, inboundIndexes] = await Promise.all([
			loadReservationEvidence(target, dependencies),
			loadLaterAuditEvidence(target, dependencies),
			loadDormantHotelRunnerState(target, dependencies.db || mongoose.connection.db),
			ReservationModel.collection.indexes(),
			InboundModel.collection.indexes(),
		]);
		assertRequiredIndexes(reservationIndexes, inboundIndexes);
		assert.deepEqual(
			reservationIndexes.find((item) => item.name === "uniq_ota_identity_key"),
			plan.basis.indexProof.reservation,
			"Primary OTA identity index changed after dry run."
		);
		assert.deepEqual(
			reservationIndexes.find((item) => item.name === "uniq_ota_cross_transport_identity_key"),
			plan.basis.indexProof.crossTransportReservation,
			"Cross-transport OTA identity index changed after dry run."
		);
		assert.deepEqual(
			inboundIndexes.find((item) => item.name === "uniq_inbound_email_dedupe_key"),
			plan.basis.indexProof.inbound,
			"Inbound dedupe index changed after dry run."
		);
		if (reservationEvidence.exact.length || reservationEvidence.plausible.length) {
			fail("RECOVERY_LAST_MOMENT_DUPLICATE", "A reservation candidate appeared at the immediate pre-insert fence.", { auditId: target.auditId, evidence: reservationEvidence.safeSummary });
		}
		if (later.terminal.length) fail("RECOVERY_LAST_MOMENT_TERMINAL", "A later terminal archive appeared at the immediate pre-insert fence.", { auditId: target.auditId, laterTerminalAuditIds: later.terminal });
		assert.deepEqual(later.fingerprints, scope.laterAuditEvidence.fingerprints, "Later relay/guest audit evidence changed after dry run.");
		assertDormantHotelRunnerState(target, dormant);
		stampRecoveryProvenance(target, reservationData, plan.plannedAt);
	};
}

async function withOutboundHttpBlocked(work) {
	const http = require("node:http");
	const https = require("node:https");
	const hadGlobalFetch = Object.prototype.hasOwnProperty.call(globalThis, "fetch");
	const originals = {
		httpRequest: http.request,
		httpGet: http.get,
		httpsRequest: https.request,
		httpsGet: https.get,
		globalFetch: globalThis.fetch,
	};
	const blocked = () => {
		const error = new RecoverySafetyError("RECOVERY_OUTBOUND_NETWORK_BLOCKED", "Outbound HTTP is disabled during this recovery.");
		throw error;
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
		if (hadGlobalFetch) globalThis.fetch = originals.globalFetch;
		else delete globalThis.fetch;
	}
}

function noNetworkSarConversionOptions() {
	return {
		apiKey: "recovery-must-use-stored-verified-evidence",
		cache: new Map(),
		fetchImpl: async () => {
			fail("RECOVERY_EXCHANGE_NETWORK_ATTEMPT", "The ordinary reconciler attempted an exchange-rate network lookup; recovery stopped.");
		},
	};
}

function tripRoundingCorrection(target) {
	if (target.provider !== "trip") return undefined;
	return {
		sourceGross: target.sourceGross,
		sourceCurrency: target.sourceCurrency,
		exchangeRateToSar: target.exchangeRateToSar,
		legacySkippedAuditSar: target.legacySkippedGrossSar,
		recoveredExactDecimalSar: target.grossSar,
		deltaSar: 0.01,
		arithmetic: "decimal_half_up",
	};
}

function auditRecoveryUpdate(scope, reconciliation, reservation) {
	const { target, normalized } = scope;
	return {
		provider: target.provider,
		providerLabel: normalized.providerLabel || (target.provider === "agoda" ? "Agoda" : "Trip.com"),
		intent: normalized.intent,
		eventType: normalized.eventType,
		processingStatus: "created",
		automationAction: "created",
		skipReason: "",
		automationComment: "Authenticated direct OTA archive recovered once through the ordinary OTA reconciler and retained in OTA Platform Review.",
		hasReservationConnection: true,
		matchedReservationBy: reconciliation?.matchedReservationBy || [],
		confirmationNumber: target.confirmationNumber,
		pmsConfirmationNumber: reservation.confirmation_number || "",
		hotelName: normalized.hotelName || "",
		roomName: normalized.roomName || "",
		sourceAmount: Number(normalized.sourceAmount || 0),
		sourceCurrency: normalized.sourceCurrency || "",
		totalAmountSar: target.grossSar,
		exchangeRateToSar: Number(normalized.exchangeRateToSar || 0),
		exchangeRateSource: normalized.exchangeRateSource || "",
		paymentCollectionModel: normalized.paymentCollectionModel || "",
		hotelId: reservation.hotelId,
		reservationMongoId: reservation._id,
		normalizedReservation: normalized,
		orchestratorDecision: {
			usedAI: false,
			skipped: true,
			skipReason: "dated_authenticated_archive_recovery",
			repairId: REPAIR_ID,
			policyDate: POLICY_DATE,
		},
		reconciliation: {
			status: reconciliation?.status || "lost_ack_recovered",
			actionTaken: reconciliation?.actionTaken || "created",
			reservationId: id(reservation._id),
			hotelId: id(reservation.hotelId),
			pmsConfirmationNumber: reservation.confirmation_number || "",
			repairId: REPAIR_ID,
			policyDate: POLICY_DATE,
			recoveredFromInboundAudit: true,
			ordinaryOtaReconciler: true,
			orderTakerNormalizationUsed: false,
			directArchiveEvidence: { inboundEmailId: target.auditId, emailHash: target.emailHash, textHash: target.textHash },
			tripGrossRoundingCorrection: tripRoundingCorrection(target),
		},
		parseWarnings: normalized.warnings || [],
		parseErrors: normalized.errors || [],
		reconcileWarnings: reconciliation?.warnings || [],
		reconcileErrors: reconciliation?.errors || [],
		processedAt: new Date(),
	};
}

async function finalizeDirectAudit(scope, reconciliation, reservation, dependencies = {}) {
	const Model = dependencies.InboundEmail || InboundEmail;
	const { target, audit } = scope;
	const result = await Model.updateOne(
		{
			_id: target.auditId,
			__v: target.version,
			source: "sendgrid",
			provider: target.provider,
			confirmationNumber: target.confirmationNumber,
			messageId: audit.messageId,
			emailHash: target.emailHash,
			textHash: target.textHash,
			dedupeKey: audit.dedupeKey,
			receivedAt: new Date(target.receivedAt),
			updatedAt: new Date(target.updatedAt),
			duplicateOf: null,
			processingStatus: "needs_review",
			skipReason: "ota_parser_requires_manual_review",
			reservationMongoId: null,
			"senderAuthentication.authenticatedAligned": true,
			"senderAuthentication.dkimAlignedPass": true,
			"senderAuthentication.trustedProvider": target.provider,
		},
		{ $set: auditRecoveryUpdate(scope, reconciliation, reservation) },
		{ writeConcern: { w: "majority" } }
	);
	if (result.matchedCount !== 1 || result.modifiedCount !== 1) {
		const observed = await Model.findById(target.auditId).lean().exec();
		if (lower(observed?.reconciliation?.repairId) !== REPAIR_ID || id(observed?.reservationMongoId) !== id(reservation._id)) {
			fail("RECOVERY_AUDIT_CAS_LOST", "The authoritative direct audit changed before finalization.", { auditId: target.auditId });
		}
	}
	const finalAudit = await Model.findById(target.auditId).lean().exec();
	assertArchiveImmutable(target, finalAudit);
	assertAppliedAuditState(target, finalAudit);
	assert.equal(id(finalAudit.reservationMongoId), id(reservation._id), "Final direct audit links another reservation.");
	return finalAudit;
}

async function applyTarget(scope, plan, dependencies = {}) {
	const { target } = scope;
	if (scope.action === "already_applied_noop") {
		return { provider: target.provider, confirmationNumber: target.confirmationNumber, action: scope.action, reservationId: id(scope.reservationEvidence.recovered[0]._id) };
	}
	let reconciliation = null;
	let reservation = scope.action === "finalize_lost_ack_only" ? scope.reservationEvidence.recovered[0] : null;
	if (!reservation) {
		const beforeCreateInsert = await makeLastMomentCreateGuard(scope, plan, dependencies);
		let reconcileError = null;
		try {
			const reconciliationOptions = {
				beforeCreateInsert,
				sarConversionOptions: noNetworkSarConversionOptions(),
				...(target.provider === "trip"
					? {
						datedRecoveryConversionBoundary:
							scope.normalized.datedRecoveryConversionEvidence,
					  }
					: {}),
			};
			reconciliation = await withOutboundHttpBlocked(() =>
				(dependencies.reconcileOtaReservation || reconcileOtaReservation)(
					scope.normalized,
					reconciliationOptions
				)
			);
		} catch (error) {
			reconcileError = error;
		}
		const evidence = await loadReservationEvidence(target, dependencies);
		if (evidence.recovered.length === 1 && evidence.exact.length === 1 && evidence.plausible.length === 0) {
			reservation = evidence.recovered[0];
		} else if (reconcileError) {
			throw reconcileError;
		} else {
			fail("RECOVERY_RECONCILE_RESULT_INVALID", "Ordinary OTA reconciliation did not leave exactly one provenance-linked reservation.", { auditId: target.auditId, status: reconciliation?.status || "", evidence: evidence.safeSummary });
		}
		if (reconcileError && !reservation) throw reconcileError;
	}
	assertExpectedReservationShape(target, reservation, { persisted: true });
	await finalizeDirectAudit(scope, reconciliation, reservation, dependencies);
	const postEvidence = await loadReservationEvidence(target, dependencies);
	assert.equal(postEvidence.exact.length, 1, "Post-recovery identity is not unique.");
	assert.equal(postEvidence.recovered.length, 1, "Post-recovery provenance is not unique.");
	assert.equal(postEvidence.plausible.length, 0, "A plausible manual duplicate appeared after recovery.");
	const postDormantHotelRunnerState = await loadDormantHotelRunnerState(
		target,
		dependencies.db || mongoose.connection.db
	);
	assertDormantHotelRunnerState(target, postDormantHotelRunnerState);
	return { provider: target.provider, confirmationNumber: target.confirmationNumber, action: scope.action, reservationId: id(reservation._id), otaPlatformReview: lower(reservation.otaPlatformReview?.status), overbookedWarningRetained: reservation.availabilitySnapshot?.overbooked === true };
}

function safePlanOutput(plan, mode) {
	return {
		mode,
		policyDate: POLICY_DATE,
		repairId: REPAIR_ID,
		plannedAt: dateIso(plan.plannedAt),
		planHash: plan.planHash,
		targetCount: TARGETS.length,
		targets: plan.basis.targets.map((target) => ({
			provider: target.provider,
			confirmationNumber: target.confirmationNumber,
			auditId: target.auditId,
			hotelId: target.mapping.hotelId,
			roomConfigId: target.mapping.roomConfigId,
			roomCount: target.normalized.roomCount,
			stay: [target.normalized.checkinDate, target.normalized.checkoutDate],
			grossSar: target.commercial.grossSar,
			payoutSar: target.commercial.payoutSar,
			expenseSar: target.commercial.expenseSar,
			rootSar: target.commercial.rootSar,
			overbooked:
				target.inventory.availabilitySnapshot?.overbooked === true,
			issueCount: Number(
				target.inventory.availabilitySnapshot?.issueCount || 0
			),
			action: target.action,
		})),
	};
}

async function run(options = parseArguments(), dependencies = {}) {
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
	const output = safePlanOutput(plan, options.apply ? "apply" : "dry-run");
	if (!options.apply) {
		output.proof = proofToken(plan);
		output.proofExpiresInMinutes = PROOF_MAX_AGE_MS / 60000;
		output.applyCommand = `npm run ota:recover-missed-direct-20260813 -- --apply --repair-id=${REPAIR_ID} --proof=${output.proof}`;
		console.log(JSON.stringify(output, null, 2));
		return output;
	}
	const results = [];
	for (const scope of plan.scopes) results.push(await applyTarget(scope, plan, dependencies));
	const final = { ...output, success: true, results, hotelRunnerApiCalls: 0, outboundHttpAllowed: false };
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
	FORBIDDEN_HOTELRUNNER_RUNTIME_MODULES,
	HOTELRUNNER_DISABLED_GATES,
	POLICY_DATE,
	PROOF_MAX_AGE_MS,
	REPAIR_ID,
	RecoverySafetyError,
	RECOVERY_RESERVATION_EVIDENCE_SELECT,
	TARGETS,
	applyTarget,
	assertAppliedAuditState,
	assertArchiveImmutable,
	assertExactTripDatedRecoveryEvidence,
	assertDormantHotelRunnerState,
	assertHotelRunnerDisabled,
	assertNoForbiddenHotelRunnerRuntimeModules,
	assertOriginalAuditState,
	assertExpectedReservationShape,
	assertRequiredIndexes,
	broadConfirmationLookup,
	buildPlan,
	canonicalize,
	dateOnly,
	emailFromAudit,
	expectedTripDatedRecoveryEvidence,
	effectiveRoomCount,
	freshNormalizedFromArchive,
	guestKeyHash,
	hashObject,
	historicalArchiveConversionTuple,
	inventoryFingerprint,
	laterAuditLookup,
	loadDormantHotelRunnerState,
	loadReservationEvidence,
	loadedForbiddenHotelRunnerModules,
	makeLastMomentCreateGuard,
	noNetworkSarConversionOptions,
	plausibleManualCandidates,
	parseArguments,
	parseProof,
	proofToken,
	recoveryMarkerMatches,
	resolveExpectedDocument,
	run,
	stampRecoveryProvenance,
	stripArchivedSubject,
	terminalLifecycle,
	tripRoundingCorrection,
	withOutboundHttpBlocked,
};
