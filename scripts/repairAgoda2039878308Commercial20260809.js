/** @format */

"use strict";

/**
 * One-time, fail-closed commercial repair for Agoda booking
 * 2039878308 only.
 *
 * Dry run:
 *   node scripts/repairAgoda2039878308Commercial20260809.js \
 *     --release-sha=<approved-merge-sha>
 *
 * Apply (use the unexpired proof printed by the dry run):
 *   node scripts/repairAgoda2039878308Commercial20260809.js \
 *     --apply \
 *     --repair-id=agoda-2039878308-commercial-20260809-v1 \
 *     --release-sha=<approved-merge-sha> \
 *     --proof=<timestamp.plan-hash>
 *
 * This script never calls Agoda, HotelRunner, email, or an exchange-rate API.
 * It reparses the immutable authenticated Agoda audit, requires exact
 * HotelRunner event/mirror corroboration for the sole audited two-room parser
 * review, and plans one full-document reservation CAS. HotelRunner evidence and
 * inbound audits are immutable and are never updated.
 */

const crypto = require("crypto");
const { execFileSync } = require("child_process");
const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const mongoose = require("mongoose");

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
	directHotelRunnerEmailCommercialGuard,
	directHotelRunnerCommercialEnrichmentSet,
	extractNormalizedReservation,
	verifiedHotelRunnerEmailCommercialEvidence,
} = require("../services/otaReservationMapper");
const {
	hasCaptureEvidence,
} = require("../services/tripHotelRunnerRepair20260805");

const REPAIR_ID = "agoda-2039878308-commercial-20260809-v1";
const BACKUP_COLLECTION = "ota_agoda_2039878308_commercial_repair_backup_20260809_v1";
const MANIFEST_COLLECTION = "ota_agoda_2039878308_commercial_repair_manifest_20260809_v1";
const PROOF_MAX_AGE_MS = 30 * 60 * 1000;
const APPLY_STRATEGY = "durable_backup_then_full_document_cas";
const CLOCK_SKEW_MS = 5_000;
const MUTATION_CAPABILITIES = new WeakSet();
const EXECUTION_PATHS = Object.freeze([
	"scripts/repairAgoda2039878308Commercial20260809.js",
	"services/recentOtaInboundRecovery20260805.js",
	"services/otaReservationMapper.js",
	"services/tripHotelRunnerRepair20260805.js",
	"models/reservations.js",
	"models/hotelrunner_event.js",
	"models/hotelrunner_reservation.js",
	"models/inbound_email.js",
]);
const MANIFEST_ACTIONABLE_STATES = Object.freeze([
	"backing_up",
	"backed_up",
	"applying",
	"applied",
]);

const TARGET = Object.freeze({
	key: "agoda_2039878308",
	otaBookingId: "2039878308",
	pmsConfirmationNumber: "2276222361",
	reservationMongoId: "6a789cea66c058f4ab621ebf",
	reservationVersion: 0,
	reservationOriginalHash:
		"f0a92de9825b08bd561e4f4fff6663ac75bf52e1f2046cc6885f79db6f49da9d",
	hotelId: "6a40b6a1a6efe70450536038",
	ownerId: "68b74714fb50e159d48c714d",
	hotelNameKey: "zadajyad",
	hotelRunnerReservationId: "40382472",
	hrNumber: "R660286537",
	eventId: "6a789cead8cbed2f4bad4732",
	eventDocumentHash:
		"ed40cf52d678750f0f819e0dbe9a7cc2950a4407479ee9893e296f937de27ec6",
	eventPayloadHash:
		"1d863683058556687b5e3493919fa20c54d09f807d2ccec00538a26da317ca14",
	eventCanonicalHash:
		"318e44d3648c03c410847fd63737df2c2291143150eaf881fb3e5fd07ed28d08",
	eventMessageUid: "420f0c3724b22de19831273393aae35d",
	mirrorId: "6a789cea66c058f4ab621eb6",
	mirrorDocumentHash:
		"b5a3d5e2c45997a766360eca0a877d5d4bed595ee785a09af282ba69024d86dd",
	mirrorNormalizedSnapshotHash:
		"2e9469751345f298f1ffc611dac210995579b6e06866cadb76f2f45bbc8a548c",
	mirrorProjectionHash:
		"47105b9edb1c8c4d894260d49c6d4f12e9339cc30b885cd199f070402e7a3621",
	directInboundEmailId: "6a789cb5f77fb5bdaf73b0b1",
	directInboundDocumentHash:
		"b59dd8ed969a6b68763c35ef2210bffa774d4fac6d9a569322802a7504f6f7e3",
	directInboundBodyHash:
		"1d97ac58bf815ed19b815743979a53e97bd7a6fa36fa7e0d885948a6671ddf01",
	directInboundEmailHash:
		"20357d5fcd16ffffa8a0f66407740caf38f7297ae9c583ca002395bda0907ef1",
	directSourceTextHash:
		"1d97ac58bf815ed19b815743979a53e97bd7a6fa36fa7e0d885948a6671ddf01",
	hotelRunnerInboundEmailId: "6a789cf2f77fb5bdaf73b12a",
	hotelRunnerInboundDocumentHash:
		"6fb58df12eaada80a1500221da488fe9b8698d6f8d0a1b95edc7e246f2fc93d3",
	hotelRunnerInboundBodyHash:
		"ae47f15b24c9d33447320a3bf28a6c8b8b0476d395064b5efe63abdd9ac98fd9",
	hotelRunnerInboundEmailHash:
		"f301682ae48b99d671d1085e00894985f36220129410b86d0b62380b05daf934",
	checkinDate: "2026-11-04",
	checkoutDate: "2026-11-07",
	roomConfigId: "6a40e0981a6d1850eb25c27c",
	hotelRunnerRoomIds: Object.freeze(["36206582", "36206584"]),
	parsedRoomName: "Triple Bed Room With Air Conditioning",
	projectedSourceRoomName:
		"Triple Bed Room With Air Conditioning - Non-Refundable - 1 Occupancy - NR",
	sourceCurrency: "SAR",
	propertyCurrency: "SAR",
	sourceGross: 588,
	sourcePayout: 363.78,
	sourceDeduction: 224.22,
	grossTotalSar: 588,
	payoutTotalSar: 363.78,
	otaExpenseTotalSar: 224.22,
	otaCommissionSar: 88.2,
	unclassifiedDeductionSar: 55.14,
	deductionComponentAmountsSar: Object.freeze([88.2, 58.8, 22.08]),
	rootTotalSar: 534,
	platformMarginSar: -170.22,
	hotelRunnerReportedSourceAmount: 363.78,
	roomCount: 2,
	nights: 3,
	pricingSlotCount: 6,
	slotGrossSar: 98,
	slotPayoutSar: 60.63,
	slotExpenseSar: 37.37,
	slotRootSar: 89,
	slotMarginSar: -28.37,
	otaCommercialEvidenceHash:
		"e5500cc81e1c61e7981d817133dcea8255adf5b909a2afb9276be877c95f0d55",
	multiRoomReviewReason:
		"Agoda email contains multiple rooms; automatic partial-room creation is disabled and the booking requires room review.",
});

const BACKUP_ROLES = Object.freeze([
	"reservation_before",
	"hotelrunner_event_evidence",
	"hotelrunner_mirror_evidence",
	"direct_agoda_email_evidence",
	"hotelrunner_email_evidence",
]);

const ALLOWED_COMMERCIAL_SET_KEYS = Object.freeze(
	new Set([
		"commission",
		"commission_ota",
		"currency",
		"total_amount",
		"pickedRoomsType",
		"pickedRoomsPricing",
		"adminPricing.clientTotal",
		"adminPricing.netAfterExpensesTotal",
		"adminPricing.otaExpenseTotal",
		"adminPricing.platformMarginTotal",
		"adminPricing.commissionAmount",
		"adminPricing.defaultDeductionApplied",
		"adminPricing.payoutFallbackReason",
		"adminPricing.commercialVerified",
		"ota_financial_summary.show",
		"ota_financial_summary.clientTotal",
		"ota_financial_summary.netAfterExpenses",
		"ota_financial_summary.netAfterOtaExpenses",
		"ota_financial_summary.otaExpenseTotal",
		"ota_financial_summary.platformProfit",
		"ota_financial_summary.commissionAmount",
		"ota_financial_summary.otaCommissionAmount",
		"ota_financial_summary.otaDeductionBreakdown",
		"ota_financial_summary.unclassifiedOtaDeduction",
		"ota_financial_summary.commercialVerified",
		"ota_financial_summary.paymentSummary",
		"ota_financial_summary.payoutFallbackReason",
		"supplierData.otaPaymentSummary",
		"supplierData.otaTotalPayoutSar",
		"supplierData.otaExpenseTotalSar",
		"supplierData.otaCommissionSar",
		"supplierData.otaCommissionSource",
		"supplierData.otaCommissionSourceBacked",
		"supplierData.otaPlatformMarginSar",
		"supplierData.otaPayoutFallbackReason",
		"supplierData.hotelRunnerEmailCommercialEvidence",
		"supplierData.otaCommercialEvidence",
	])
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

function fail(message, code = "AGODA_2039878308_COMMERCIAL_REPAIR_BLOCKED") {
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
			if (apply) fail("--apply may be supplied only once.", "AGODA_2039878308_REPAIR_ARGUMENT_INVALID");
			apply = true;
			continue;
		}
		if (argument.startsWith("--repair-id=")) {
			if (repairId) fail("--repair-id may be supplied only once.", "AGODA_2039878308_REPAIR_ARGUMENT_INVALID");
			repairId = argument.slice("--repair-id=".length);
			continue;
		}
		if (argument.startsWith("--release-sha=")) {
			if (releaseSha) fail("--release-sha may be supplied only once.", "AGODA_2039878308_REPAIR_ARGUMENT_INVALID");
			releaseSha = lower(argument.slice("--release-sha=".length));
			continue;
		}
		if (argument.startsWith("--proof=")) {
			if (proof) fail("--proof may be supplied only once.", "AGODA_2039878308_REPAIR_ARGUMENT_INVALID");
			proof = lower(argument.slice("--proof=".length));
			continue;
		}
		fail("Unsupported Agoda commercial repair argument.", "AGODA_2039878308_REPAIR_ARGUMENT_INVALID");
	}
	if (!/^[a-f0-9]{40}$/.test(releaseSha)) {
		fail("An exact 40-character --release-sha is required.", "AGODA_2039878308_REPAIR_RELEASE_REQUIRED");
	}
	if (!apply && (repairId || proof)) {
		fail("--repair-id and --proof are apply-only arguments.", "AGODA_2039878308_REPAIR_ARGUMENT_INVALID");
	}
	if (apply && repairId !== REPAIR_ID) {
		fail(`Apply requires --repair-id=${REPAIR_ID}.`, "AGODA_2039878308_REPAIR_ID_REQUIRED");
	}
	if (apply && !/^\d{13}\.[a-f0-9]{64}$/.test(proof)) {
		fail("Apply requires the exact unexpired dry-run proof.", "AGODA_2039878308_REPAIR_PROOF_REQUIRED");
	}
	return { apply, repairId, releaseSha, proof };
}

function parseProof(proof, now = new Date()) {
	const match = lower(proof).match(/^(\d{13})\.([a-f0-9]{64})$/);
	if (!match) fail("The dry-run proof format is invalid.", "AGODA_2039878308_REPAIR_PROOF_INVALID");
	const plannedAtMs = Number(match[1]);
	const nowMs = now.getTime();
	if (
		!Number.isSafeInteger(plannedAtMs) ||
		plannedAtMs > nowMs + CLOCK_SKEW_MS ||
		nowMs - plannedAtMs > PROOF_MAX_AGE_MS
	) {
		fail("The dry-run proof is expired or from the future.", "AGODA_2039878308_REPAIR_PROOF_EXPIRED");
	}
	return {
		plannedAt: new Date(plannedAtMs),
		expiresAt: new Date(plannedAtMs + PROOF_MAX_AGE_MS),
		planHash: match[2],
	};
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
		fail("Could not resolve the deployed Git release SHA.", "AGODA_2039878308_REPAIR_RELEASE_UNRESOLVED");
	}
}

function assertRelease(expected, actual) {
	if (!/^[a-f0-9]{40}$/.test(lower(actual)) || lower(actual) !== lower(expected)) {
		fail(
			"The deployed checkout does not equal the explicitly approved merge SHA.",
			"AGODA_2039878308_REPAIR_RELEASE_MISMATCH"
		);
	}
}

function attestExecutionCheckout({
	releaseSha,
	repoRoot = path.resolve(__dirname, ".."),
} = {}) {
	const runGit = (args) =>
		String(
			execFileSync("git", args, {
				cwd: repoRoot,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			})
		).trim();
	try {
		const observedReleaseSha = lower(runGit(["rev-parse", "HEAD"]));
		const treeSha = lower(runGit(["rev-parse", "HEAD^{tree}"]));
		const trackedStatus = runGit([
			"status",
			"--porcelain=v1",
			"--untracked-files=no",
		]);
		const dependencies = EXECUTION_PATHS.map((filePath) => {
			const line = runGit(["ls-tree", "HEAD", "--", filePath]);
			const match = line.match(/^\d+\s+blob\s+([a-f0-9]{40})\t(.+)$/i);
			if (!match || match[2] !== filePath) {
				fail(
					"A repair execution dependency is absent from the approved tree.",
					"AGODA_2039878308_REPAIR_EXECUTION_INVALID"
				);
			}
			return { path: filePath, blobSha: lower(match[1]) };
		});
		assertRelease(releaseSha, observedReleaseSha);
		return {
			releaseSha: observedReleaseSha,
			treeSha,
			executionFingerprint: canonicalEjsonSha256({
				releaseSha: observedReleaseSha,
				treeSha,
				dependencies,
			}),
			trackedWorktreeClean: trackedStatus === "",
		};
	} catch (error) {
		if (String(error?.code || "").startsWith("AGODA_2039878308_")) throw error;
		fail(
			"The executing checkout could not be attested.",
			"AGODA_2039878308_REPAIR_EXECUTION_INVALID"
		);
	}
}

function assertExecution(execution, releaseSha) {
	if (
		lower(execution?.releaseSha) !== lower(releaseSha) ||
		!/^[a-f0-9]{40}$/.test(lower(execution?.treeSha)) ||
		!/^[a-f0-9]{64}$/.test(lower(execution?.executionFingerprint)) ||
		execution?.trackedWorktreeClean !== true
	) {
		fail(
			"A clean checkout of the exact approved release is required.",
			"AGODA_2039878308_REPAIR_EXECUTION_DIRTY"
		);
	}
	return Object.freeze({
		releaseSha: lower(execution.releaseSha),
		treeSha: lower(execution.treeSha),
		executionFingerprint: lower(execution.executionFingerprint),
		trackedWorktreeClean: true,
	});
}

function createMutationCapability({ plan, proofDetails, execution, clock }) {
	if (
		proofDetails?.planHash !== plan?.planHash ||
		proofToken(plan) !==
			`${proofDetails?.plannedAt?.getTime()}.${proofDetails?.planHash}`
	) {
		fail(
			"The mutation capability does not match the dry-run proof.",
			"AGODA_2039878308_REPAIR_PROOF_MISMATCH"
		);
	}
	const capability = {
		planHash: plan.planHash,
		releaseSha: plan.releaseSha,
		executionFingerprint: execution.executionFingerprint,
		proofIssuedAt: new Date(proofDetails.plannedAt),
		proofExpiresAt: new Date(proofDetails.expiresAt),
		mutationStartedAt: null,
		clock,
	};
	MUTATION_CAPABILITIES.add(capability);
	return capability;
}

function assertMutationCapability(
	capability,
	plan,
	{ mutationBoundary = true } = {}
) {
	if (
		!capability ||
		!MUTATION_CAPABILITIES.has(capability) ||
		capability.planHash !== plan?.planHash ||
		capability.releaseSha !== plan?.releaseSha ||
		capability.executionFingerprint !== plan?.execution?.executionFingerprint ||
		typeof capability.clock !== "function"
	) {
		fail(
			"The database mutation boundary is not authorized.",
			"AGODA_2039878308_REPAIR_WRITE_UNAUTHORIZED"
		);
	}
	const now = new Date(capability.clock());
	const startedAt = capability.mutationStartedAt
		? new Date(capability.mutationStartedAt)
		: null;
	if (!Number.isFinite(now.getTime())) {
		fail("The mutation clock is invalid.", "AGODA_2039878308_REPAIR_PROOF_EXPIRED");
	}
	if (startedAt) {
		if (
			!Number.isFinite(startedAt.getTime()) ||
			startedAt < capability.proofIssuedAt ||
			startedAt > capability.proofExpiresAt
		) {
			fail(
				"The mutation start was not inside the dry-run proof window.",
				"AGODA_2039878308_REPAIR_PROOF_EXPIRED"
			);
		}
		return now;
	}
	if (now < capability.proofIssuedAt || now > capability.proofExpiresAt) {
		fail(
			"The dry-run proof expired before a database mutation.",
			"AGODA_2039878308_REPAIR_PROOF_EXPIRED"
		);
	}
	if (mutationBoundary) capability.mutationStartedAt = new Date(now);
	return now;
}

function reservationLookup(target = TARGET) {
	return {
		$or: [
			{ _id: target.reservationMongoId },
			{ confirmation_number: target.pmsConfirmationNumber },
			{ reservation_id: target.otaBookingId },
			{ otaIdentityKey: `agoda:${target.otaBookingId}` },
			{ otaCrossTransportIdentityKey: `agoda:${target.otaBookingId}` },
			{ "customer_details.confirmation_number2": target.otaBookingId },
			{ "supplierData.suppliedBookingNo": target.otaBookingId },
			{ "supplierData.otaConfirmationNumber": target.otaBookingId },
			{ "supplierData.platformConfirmationNumber": target.otaBookingId },
			{ "supplierData.hotelRunner.reservationId": target.hotelRunnerReservationId },
		],
	};
}

function eventLookup(target = TARGET) {
	return {
		$or: [
			{ _id: target.eventId },
			{ providerNumber: target.otaBookingId },
			{ hrNumber: target.hrNumber },
			{ hotelRunnerReservationId: target.hotelRunnerReservationId },
			{ reservationMongoId: target.reservationMongoId },
		],
	};
}

function mirrorLookup(target = TARGET) {
	return {
		$or: [
			{ _id: target.mirrorId },
			{ providerNumber: target.otaBookingId },
			{ providerNumberAliases: target.otaBookingId },
			{ hrNumber: target.hrNumber },
			{ hrNumberAliases: target.hrNumber },
			{ hotelRunnerReservationId: target.hotelRunnerReservationId },
			{ reservationMongoId: target.reservationMongoId },
		],
	};
}

function inboundLookup(target = TARGET) {
	return {
		$or: [
			{
				_id: {
					$in: [target.directInboundEmailId, target.hotelRunnerInboundEmailId],
				},
			},
			{ confirmationNumber: target.otaBookingId },
			{ "normalizedReservation.confirmationNumber": target.otaBookingId },
			{ "normalizedReservation.reservationId": target.otaBookingId },
			{ reservationMongoId: target.reservationMongoId },
		],
	};
}

async function leanMany(Model, filter, { select = "", limit = 6 } = {}) {
	let query = Model.find(filter);
	if (select && typeof query.select === "function") query = query.select(select);
	if (typeof query.limit === "function") query = query.limit(limit);
	if (typeof query.read === "function") query = query.read("primary");
	if (typeof query.readConcern === "function") query = query.readConcern("majority");
	if (typeof query.lean === "function") query = query.lean();
	if (typeof query.exec === "function") return query.exec();
	return query;
}

async function leanOne(Model, filter, options = {}) {
	const rows = await leanMany(Model, filter, { ...options, limit: 2 });
	if (!Array.isArray(rows) || rows.length !== 1) {
		fail(`Expected exactly one immutable document; found ${rows?.length || 0}.`);
	}
	return rows[0];
}

function assertExactHash(document, expected, label) {
	const actual = canonicalEjsonSha256(document);
	if (!/^[a-f0-9]{64}$/.test(lower(expected)) || actual !== lower(expected)) {
		fail(`${label} full-document hash changed.`, "AGODA_2039878308_REPAIR_SOURCE_HASH_MISMATCH");
	}
	return actual;
}

function assertHotel(target, hotel) {
	const room = (Array.isArray(hotel?.roomCountDetails) ? hotel.roomCountDetails : []).filter(
		(item) => clean(item?._id) === target.roomConfigId && item?.activeRoom !== false
	);
	if (
		clean(hotel?._id) !== target.hotelId ||
		clean(hotel?.belongsTo) !== target.ownerId ||
		lower(hotel?.hotelName).replace(/[^a-z0-9]+/g, "") !== target.hotelNameKey ||
		hotel?.activateHotel !== true ||
		hotel?.xHotelProActive === false ||
		room.length !== 1
	) {
		fail("The exact hotel/owner/room configuration boundary changed.");
	}
}

function assertEvent(target, event) {
	assertExactHash(event, target.eventDocumentHash, "HotelRunner event");
	if (
		clean(event?._id) !== target.eventId ||
		clean(event?.hotelId) !== target.hotelId ||
		clean(event?.hotelRunnerReservationId) !== target.hotelRunnerReservationId ||
		upper(event?.hrNumber) !== target.hrNumber ||
		clean(event?.providerNumber) !== target.otaBookingId ||
		lower(event?.channel) !== "agodaycs5" ||
		lower(event?.source) !== "push" ||
		lower(event?.state) !== "confirmed" ||
		lower(event?.status) !== "completed" ||
		event?.integrityConflict === true ||
		Number(event?.integrityConflictCount || 0) !== 0 ||
		lower(event?.payloadHash) !== target.eventPayloadHash ||
		lower(event?.canonicalHash) !== target.eventCanonicalHash ||
		clean(event?.messageUid) !== target.eventMessageUid ||
		clean(event?.reservationMongoId) !== target.reservationMongoId ||
		clean(event?.mirrorId) !== target.mirrorId
	) {
		fail("The exact HotelRunner event envelope changed.");
	}
}

function assertMirror(target, mirror) {
	assertExactHash(mirror, target.mirrorDocumentHash, "HotelRunner mirror");
	if (
		clean(mirror?._id) !== target.mirrorId ||
		clean(mirror?.hotelId) !== target.hotelId ||
		clean(mirror?.hotelRunnerReservationId) !== target.hotelRunnerReservationId ||
		upper(mirror?.hrNumber) !== target.hrNumber ||
		clean(mirror?.providerNumber) !== target.otaBookingId ||
		!Array.isArray(mirror?.providerNumberAliases) ||
		!mirror.providerNumberAliases.includes(target.otaBookingId) ||
		lower(mirror?.channel) !== "agodaycs5" ||
		lower(mirror?.state) !== "confirmed" ||
		mirror?.identityConflict === true ||
		lower(mirror?.projectionStatus) !== "created" ||
		Number(mirror?.projectionVersion) !== 1 ||
		lower(mirror?.observedCanonicalHash) !== target.eventCanonicalHash ||
		lower(mirror?.appliedCanonicalHash) !== target.eventCanonicalHash ||
		canonicalEjsonSha256(mirror?.normalizedSnapshot || {}) !==
			target.mirrorNormalizedSnapshotHash ||
		canonicalEjsonSha256(mirror?.lastAppliedProjection || {}) !==
			target.mirrorProjectionHash ||
		clean(mirror?.reservationMongoId) !== target.reservationMongoId ||
		Number(mirror?.normalizedSnapshot?.totalCents) !==
			Math.round(target.hotelRunnerReportedSourceAmount * 100) ||
		upper(mirror?.normalizedSnapshot?.currency) !== target.sourceCurrency
	) {
		fail("The exact HotelRunner mirror envelope changed.");
	}
}

function assertInbound(target, audit, role) {
	const direct = role === "direct_agoda_email_evidence";
	const expectedId = direct
		? target.directInboundEmailId
		: target.hotelRunnerInboundEmailId;
	const expectedDocumentHash = direct
		? target.directInboundDocumentHash
		: target.hotelRunnerInboundDocumentHash;
	const expectedBodyHash = direct
		? target.directInboundBodyHash
		: target.hotelRunnerInboundBodyHash;
	const expectedEmailHash = direct
		? target.directInboundEmailHash
		: target.hotelRunnerInboundEmailHash;
	assertExactHash(
		audit,
		expectedDocumentHash,
		direct ? "direct Agoda audit" : "HotelRunner relay audit"
	);
	if (
		clean(audit?._id) !== expectedId ||
		sha256(audit?.bodyText) !== expectedBodyHash ||
		clean(audit?.textHash) !== expectedBodyHash ||
		clean(audit?.emailHash) !== expectedEmailHash ||
		clean(audit?.confirmationNumber) !== target.otaBookingId ||
		audit?.senderAuthentication?.authenticatedAligned !== true ||
		lower(audit?.senderAuthentication?.trustedProvider) !==
			(direct ? "agoda" : "hotelrunner") ||
		lower(audit?.provider) !== "agoda"
	) {
		fail(`${direct ? "Direct Agoda" : "HotelRunner"} inbound evidence changed.`);
	}
	if (direct) {
		if (
			lower(audit?.processingStatus) !== "needs_review" ||
			lower(audit?.automationAction) !== "skipped" ||
			lower(audit?.skipReason) !== "ota_parser_requires_manual_review"
		) {
			fail("The direct Agoda parser-review envelope changed.");
		}
	} else if (
		audit?.hasReservationConnection === true ||
		clean(audit?.reservationMongoId)
	) {
		fail("The HotelRunner relay audit unexpectedly acquired reservation ownership.");
	}
}

function trustedExchangeEvidence(target, audit) {
	const stored = audit?.normalizedReservation || {};
	const stableConvertedAt =
		stored?.paymentSummary?.amountConvertedAt ||
		stored?.amountConvertedAt ||
		stored?.source?.receivedAt ||
		audit?.receivedAt;
	const convertedAt = new Date(stableConvertedAt);
	if (
		upper(stored?.propertyCurrency || target.propertyCurrency) !==
			target.propertyCurrency ||
		!Number.isFinite(convertedAt.getTime()) ||
		(stored?.exchangeRateToSar != null &&
			Math.abs(Number(stored.exchangeRateToSar) - 1) > 0.000001) ||
		(stored?.exchangeRateSource &&
			lower(stored.exchangeRateSource) !== "identity")
	) {
		fail("Stored SAR identity-conversion evidence changed.");
	}
	return {
		trusted: true,
		verified: true,
		sourceCurrency: target.sourceCurrency,
		propertyCurrency: target.propertyCurrency,
		rate: 1,
		provenance: {
			provider: "identity",
			sourceType: "same_currency",
			sourceHash: sha256("SAR:SAR:1"),
			sourceTimestamp: convertedAt.toISOString(),
			sourceId: "identity-sar-sar",
		},
		convertedAt: convertedAt.toISOString(),
	};
}

function normalizedFromAudit(target, audit) {
	const parsed = extractNormalizedReservation({
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
			audit?.normalizedReservation?.source?.timestampMethod ||
			"stored_inbound_audit",
	});
	const stored = audit.normalizedReservation || {};
	const conversion = trustedExchangeEvidence(target, audit);
	const reviewReasons = Array.isArray(parsed?.manualReviewReasons)
		? parsed.manualReviewReasons
		: [];
	const parsedPayout = Number(
		parsed?.totalPayoutSar ?? parsed?.paymentSummary?.totalPayoutAmount
	);
	if (
		parsed.provider !== "agoda" ||
		parsed.trustedTransportProvider !== "agoda" ||
		parsed.sourceSenderTrusted !== true ||
		parsed.sourceSenderAuthenticated !== true ||
		parsed.genericRepeatedFactConflict === true ||
		(Array.isArray(parsed.genericRepeatedFactConflictFields) &&
			parsed.genericRepeatedFactConflictFields.length !== 0) ||
		parsed.requiresManualReview !== true ||
		parsed.ambiguousMultiRoomEvidence !== true ||
		parsed.blocksUnmappedReservationCreation !== true ||
		reviewReasons.length !== 1 ||
		reviewReasons[0] !== target.multiRoomReviewReason ||
		parsed.sourcePresence?.roomName !== true ||
		clean(parsed.confirmationNumber) !== target.otaBookingId ||
		dateKey(parsed.checkinDate) !== target.checkinDate ||
		dateKey(parsed.checkoutDate) !== target.checkoutDate ||
		Number(parsed.roomCount) !== target.roomCount ||
		clean(parsed.roomName) !== target.parsedRoomName ||
		upper(parsed.sourceCurrency) !== target.sourceCurrency ||
		round2(parsed.sourceAmount) !== target.sourceGross ||
		round2(parsedPayout) !== target.sourcePayout ||
		round2(parsed.otaCommissionSar) !== target.otaCommissionSar ||
		upper(parsed.paymentSummary?.currency || parsed.propertyCurrency) !==
			target.propertyCurrency
	) {
		fail(
			"The deployed parser no longer yields the exact authenticated Agoda facts and sole multi-room review."
		);
	}
	if (
		clean(stored?.source?.textHash) !== target.directSourceTextHash ||
		round2(stored.sourceAmount) !== target.sourceGross ||
		round2(stored.totalPayoutSar ?? stored.sourcePayoutAmount) !==
			target.sourcePayout ||
		upper(stored.sourceCurrency) !== target.sourceCurrency
	) {
		fail("Stored source-only Agoda facts changed.");
	}
	return {
		...parsed,
		intent: audit.intent,
		eventType: audit.eventType,
		// Exact incident-only waiver: every parser conflict above must have been
		// disproved except the one allocation review, and HotelRunner independently
		// proves two mapped room rows and six matching payout slots.
		requiresManualReview: false,
		inboundEmailId: target.directInboundEmailId,
		sourceAmount: target.sourceGross,
		sourceCurrency: target.sourceCurrency,
		sourcePayoutAmount: target.sourcePayout,
		sourcePayoutCurrency: target.sourceCurrency,
		propertyCurrency: target.propertyCurrency,
		propertyConversionVerified: true,
		amount: target.grossTotalSar,
		currency: target.propertyCurrency,
		totalAmountSar: target.grossTotalSar,
		totalPayoutSar: target.payoutTotalSar,
		netAfterExpensesTotal: target.payoutTotalSar,
		exchangeRateToSar: 1,
		exchangeRateSource: "identity",
		sourceExchangeRateToSar: 1,
		sourceExchangeRateSource: "identity",
		amountConvertedAt: conversion.convertedAt,
		paymentSummary: {
			...(parsed.paymentSummary || {}),
			sourceCurrency: target.sourceCurrency,
			sourceTotalGuestPaymentAmount: target.sourceGross,
			sourceTotalPayoutAmount: target.sourcePayout,
			sourceTotalPayoutCurrency: target.sourceCurrency,
			totalGuestPaymentAmount: target.grossTotalSar,
			totalPayoutAmount: target.payoutTotalSar,
			currency: target.propertyCurrency,
			propertyCurrency: target.propertyCurrency,
			propertyConversionVerified: true,
			exchangeRateToSar: 1,
			exchangeRateSource: "identity",
			amountConvertedAt: conversion.convertedAt,
		},
		source: {
			...(parsed.source || {}),
			receivedAt:
				stored?.source?.receivedAt ||
				parsed?.source?.receivedAt ||
				audit.receivedAt,
			textHash: target.directSourceTextHash,
		},
	};
}
function roomProtectedProjection(rooms = []) {
	return (Array.isArray(rooms) ? rooms : []).map((room) => {
		const next = cloneBson(room || {});
		delete next.totalPriceWithCommission;
		delete next.chosenPrice;
		for (const day of Array.isArray(next.pricingByDay) ? next.pricingByDay : []) {
			for (const key of [
				"price",
				"clientPrice",
				"mainPrice",
				"totalPriceWithCommission",
				"netAfterExpenses",
				"netAfterOtaExpenses",
				"otaExpenseAmount",
				"platformMargin",
				"commercialVerification",
			]) {
				delete day[key];
			}
		}
		return next;
	});
}

function deletePaths(document, paths) {
	for (const pathText of paths) {
		const parts = pathText.split(".");
		let current = document;
		for (const part of parts.slice(0, -1)) {
			if (!current || typeof current !== "object") break;
			current = current[part];
		}
		if (current && typeof current === "object") delete current[parts.at(-1)];
	}
}

function protectedReservationSnapshot(reservation = {}) {
	const snapshot = cloneBson(reservation);
	deletePaths(snapshot, [
		"__v",
		"updatedAt",
		"currency",
		"total_amount",
		"commission",
		"commission_ota",
		...Array.from(ALLOWED_COMMERCIAL_SET_KEYS).filter(
			(pathText) => !["pickedRoomsType", "pickedRoomsPricing"].includes(pathText)
		),
	]);
	snapshot.reservationAuditLog = (
		Array.isArray(reservation.reservationAuditLog)
			? reservation.reservationAuditLog
			: []
	).filter((entry) => clean(entry?.repairId) !== REPAIR_ID);
	snapshot.pickedRoomsType = roomProtectedProjection(reservation.pickedRoomsType);
	snapshot.pickedRoomsPricing = roomProtectedProjection(
		reservation.pickedRoomsPricing
	);
	return snapshot;
}

function dailyRows(reservation = {}) {
	return (Array.isArray(reservation.pickedRoomsPricing)
		? reservation.pickedRoomsPricing
		: []
	).flatMap((room) =>
		(Array.isArray(room?.pricingByDay) ? room.pricingByDay : []).map((day) => ({
			date: dateKey(day?.date),
			client: round2(day?.clientPrice),
			root: round2(day?.rootPrice),
			payout: round2(day?.netAfterExpenses),
			expense: round2(day?.otaExpenseAmount),
			margin: round2(day?.platformMargin),
			hotelRunnerSource: round2(day?.hotelRunnerSourcePrice),
		}))
	);
}

function assertReservationBoundary(
	target,
	reservation,
	{ applied = false, releaseSha = "" } = {}
) {
	const rooms = Array.isArray(reservation?.pickedRoomsPricing)
		? reservation.pickedRoomsPricing
		: [];
	const typeRooms = Array.isArray(reservation?.pickedRoomsType)
		? reservation.pickedRoomsType
		: [];
	const hotelRunnerRoomIds = rooms.map((room) =>
		clean(room?.hotelRunnerRoomId)
	);
	const hotelRunnerPricing = reservation?.supplierData?.hotelRunner?.pricing || {};
	const hotelRunnerPricingRooms = Array.isArray(hotelRunnerPricing.rooms)
		? hotelRunnerPricing.rooms
		: [];
	const hotelRunnerPricingRoomIds = hotelRunnerPricingRooms.map((room) =>
		clean(room?.roomId)
	);
	const hotelRunnerPricingSlots = hotelRunnerPricingRooms.flatMap((room) =>
		(Array.isArray(room?.nightly) ? room.nightly : []).map((day) => ({
			date: dateKey(day?.date),
			amount: round2(day?.finalPrice),
		}))
	);
	const allDates = rooms.flatMap((room) =>
		(Array.isArray(room?.pricingByDay) ? room.pricingByDay : []).map((day) =>
			dateKey(day?.date)
		)
	);
	const expectedDates = [
		target.checkinDate,
		"2026-11-05",
		"2026-11-06",
		target.checkinDate,
		"2026-11-05",
		"2026-11-06",
	].sort();
	const repairAudits = (
		Array.isArray(reservation?.reservationAuditLog)
			? reservation.reservationAuditLog
			: []
	).filter((entry) => clean(entry?.repairId) === REPAIR_ID);
	if (
		clean(reservation?._id) !== target.reservationMongoId ||
		clean(reservation?.hotelId) !== target.hotelId ||
		clean(reservation?.belongsTo) !== target.ownerId ||
		clean(reservation?.confirmation_number) !== target.pmsConfirmationNumber ||
		clean(reservation?.reservation_id) !== target.otaBookingId ||
		upper(reservation?.hr_number) !== target.hrNumber ||
		lower(reservation?.otaIdentityKey) !== `agoda:${target.otaBookingId}` ||
		clean(reservation?.otaCrossTransportIdentityKey) !== "" ||
		lower(reservation?.booking_source) !== "agoda" ||
		lower(reservation?.supplierData?.otaProvider) !== "agoda" ||
		lower(reservation?.supplierData?.supplierName) !== "agoda" ||
		lower(reservation?.supplierData?.hotelRunner?.transport) !==
			"hotelrunner_api" ||
		clean(reservation?.supplierData?.hotelRunner?.reservationId) !==
			target.hotelRunnerReservationId ||
		Number(hotelRunnerPricing?.schemaVersion) !== 1 ||
		lower(hotelRunnerPricing?.source) !== "hotelrunner_api" ||
		upper(hotelRunnerPricing?.currency) !== target.propertyCurrency ||
		round2(hotelRunnerPricing?.grandTotal) !==
			target.hotelRunnerReportedSourceAmount ||
		hotelRunnerPricing?.hotelNetPayout != null ||
		lower(hotelRunnerPricing?.hotelNetStatus) !==
			"not_provided_by_hotelrunner" ||
		hotelRunnerPricingRooms.length !== target.roomCount ||
		canonicalEjsonSha256([...hotelRunnerPricingRoomIds].sort()) !==
			canonicalEjsonSha256([...target.hotelRunnerRoomIds].sort()) ||
		hotelRunnerPricingSlots.length !== target.pricingSlotCount ||
		hotelRunnerPricingSlots.some(
			(slot) =>
				slot.amount !== target.slotPayoutSar ||
				![target.checkinDate, "2026-11-05", "2026-11-06"].includes(
					slot.date
				)
		) ||
		lower(reservation?.state) !== "ota platform review" ||
		lower(reservation?.reservation_status) !== "ota platform review" ||
		dateKey(reservation?.checkin_date) !== target.checkinDate ||
		dateKey(reservation?.checkout_date) !== target.checkoutDate ||
		Number(reservation?.total_rooms) !== target.roomCount ||
		round2(reservation?.sub_total) !== target.rootTotalSar ||
		round2(reservation?.adminPricing?.rootTotal) !== target.rootTotalSar ||
		round2(reservation?.ota_financial_summary?.hotelVisibleAmount) !==
			target.rootTotalSar ||
		rooms.length !== target.roomCount ||
		typeRooms.length !== target.roomCount ||
		rooms.some(
			(room) =>
				clean(room?.hotelRoomConfigId) !== target.roomConfigId ||
				clean(room?.localRoomConfigId) !== target.roomConfigId ||
				clean(room?.sourceRoomName) !== target.projectedSourceRoomName ||
				Number(room?.count || 1) !== 1 ||
				!Array.isArray(room?.pricingByDay) ||
				room.pricingByDay.length !== target.nights ||
				room.pricingByDay.some(
					(day) => round2(day?.rootPrice) !== target.slotRootSar
				)
		) ||
		canonicalEjsonSha256([...hotelRunnerRoomIds].sort()) !==
			canonicalEjsonSha256([...target.hotelRunnerRoomIds].sort()) ||
		canonicalEjsonSha256([...allDates].sort()) !==
			canonicalEjsonSha256(expectedDates) ||
		canonicalEjsonSha256(typeRooms) !== canonicalEjsonSha256(rooms) ||
		hasCaptureEvidence(reservation)
	) {
		fail(
			"The exact reservation identity, HotelRunner ownership, lifecycle, stay, two-room allocation, root, or protected payment boundary changed."
		);
	}
	if (applied) {
		if (
			repairAudits.length !== 1 ||
			clean(repairAudits[0]?.otaBookingId) !== target.otaBookingId ||
			clean(repairAudits[0]?.directInboundEmailId) !==
				target.directInboundEmailId ||
			clean(repairAudits[0]?.eventId) !== target.eventId ||
			clean(repairAudits[0]?.mirrorId) !== target.mirrorId ||
			(releaseSha && lower(repairAudits[0]?.releaseSha) !== lower(releaseSha)) ||
			repairAudits[0]?.vendorApiCalls !== 0
		) {
			fail("The append-only incident repair audit is absent or changed.");
		}
	} else if (repairAudits.length !== 0) {
		fail("The pre-repair reservation already contains this repair marker.");
	}
	if (!applied) {
		if (
			Number(reservation.__v) !== target.reservationVersion ||
			upper(reservation.currency) !== target.sourceCurrency ||
			round2(reservation.total_amount) !==
				target.hotelRunnerReportedSourceAmount ||
			round2(reservation.adminPricing?.clientTotal) !==
				target.hotelRunnerReportedSourceAmount ||
			reservation.adminPricing?.netAfterExpensesTotal != null ||
			reservation.adminPricing?.commercialVerified === true ||
			reservation.ota_financial_summary?.commercialVerified === true ||
			reservation.commission_ota !== null
		) {
			fail("The exact pre-repair Agoda commercial state changed.");
		}
		assertExactHash(reservation, target.reservationOriginalHash, "Agoda reservation");
	}
}

function assertCommercialProjection(target, reservation, evidence = null) {
	const rows = dailyRows(reservation);
	const marker = verifiedHotelRunnerEmailCommercialEvidence(reservation, {
		provider: "agoda",
		grossTotalSar: target.grossTotalSar,
		currency: target.propertyCurrency,
	});
	const common = reservation?.supplierData?.otaCommercialEvidence;
	const sums = (field) => round2(rows.reduce((sum, row) => sum + row[field], 0));
	if (
		upper(reservation.currency) !== target.propertyCurrency ||
		round2(reservation.total_amount) !== target.grossTotalSar ||
		round2(reservation.sub_total) !== target.rootTotalSar ||
		round2(reservation.commission) !== 0 ||
		round2(reservation.commission_ota) !== target.otaCommissionSar ||
		reservation.adminPricing?.commercialVerified !== true ||
		round2(reservation.adminPricing?.clientTotal) !== target.grossTotalSar ||
		round2(reservation.adminPricing?.netAfterExpensesTotal) !==
			target.payoutTotalSar ||
		round2(reservation.adminPricing?.otaExpenseTotal) !==
			target.otaExpenseTotalSar ||
		round2(reservation.adminPricing?.platformMarginTotal) !==
			target.platformMarginSar ||
		reservation.ota_financial_summary?.commercialVerified !== true ||
		round2(reservation.ota_financial_summary?.clientTotal) !==
			target.grossTotalSar ||
		round2(reservation.ota_financial_summary?.netAfterExpenses) !==
			target.payoutTotalSar ||
		round2(reservation.ota_financial_summary?.otaExpenseTotal) !==
			target.otaExpenseTotalSar ||
		round2(reservation.ota_financial_summary?.otaCommissionAmount) !==
			target.otaCommissionSar ||
		round2(reservation.ota_financial_summary?.unclassifiedOtaDeduction) !==
			target.unclassifiedDeductionSar ||
		rows.length !== target.pricingSlotCount ||
		rows.some(
			(row) =>
				row.client !== target.slotGrossSar ||
				row.root !== target.slotRootSar ||
				row.payout !== target.slotPayoutSar ||
				row.expense !== target.slotExpenseSar ||
				row.margin !== target.slotMarginSar ||
				row.hotelRunnerSource !== target.slotPayoutSar
		) ||
		sums("client") !== target.grossTotalSar ||
		sums("root") !== target.rootTotalSar ||
		sums("payout") !== target.payoutTotalSar ||
		sums("expense") !== target.otaExpenseTotalSar ||
		sums("margin") !== target.platformMarginSar ||
		!marker ||
		(evidence && marker.evidenceHash !== evidence.evidenceHash) ||
		common?.verificationState !== "verified" ||
		common?.evidenceHash !== target.otaCommercialEvidenceHash ||
		round2(common?.roles?.guestGross?.sourceAmount) !== target.sourceGross ||
		upper(common?.roles?.guestGross?.sourceCurrency) !== target.sourceCurrency ||
		round2(common?.roles?.guestGross?.propertyAmount) !== target.grossTotalSar ||
		round2(common?.roles?.hotelPayout?.sourceAmount) !== target.sourcePayout ||
		round2(common?.roles?.hotelPayout?.propertyAmount) !== target.payoutTotalSar ||
		round2(common?.roles?.deductionAggregate?.sourceAmount) !==
			target.sourceDeduction ||
		round2(common?.roles?.deductionAggregate?.propertyAmount) !==
			target.otaExpenseTotalSar ||
		common?.roles?.explicitOtaCommission?.verified !== true ||
		round2(common?.roles?.explicitOtaCommission?.propertyAmount) !==
			target.otaCommissionSar
	) {
		fail("The planned/applied Agoda SAR commercial projection is not exact.");
	}
	return marker;
}

function buildExpectedReservation(
	target,
	reservation,
	audit,
	repairAt,
	{ hotel, releaseSha = "" } = {}
) {
	const normalized = normalizedFromAudit(target, audit);
	const evidence = buildHotelRunnerEmailCommercialEvidence(normalized, {
		appliedAt: repairAt,
	});
	if (
		!evidence ||
		evidence.version !== 2 ||
		evidence.verified !== true ||
		evidence.provider !== "agoda" ||
		evidence.otaIdentityKey !== `agoda:${target.otaBookingId}` ||
		!/^[a-f0-9]{64}$/.test(lower(evidence.evidenceHash)) ||
		round2(evidence.grossTotalSar) !== target.grossTotalSar ||
		round2(evidence.payoutTotalSar) !== target.payoutTotalSar ||
		round2(evidence.otaExpenseTotalSar) !== target.otaExpenseTotalSar ||
		round2(evidence.otaCommissionSar) !== target.otaCommissionSar ||
		round2(evidence.unclassifiedDeductionSar) !==
			target.unclassifiedDeductionSar ||
		canonicalEjsonSha256(
			(evidence.deductionComponents || []).map((entry) =>
				round2(entry?.amountSar)
			)
		) !== canonicalEjsonSha256(target.deductionComponentAmountsSar)
	) {
		fail("The authenticated Agoda legacy commercial evidence contract changed.");
	}
	const commercialExisting = cloneBson(reservation);
	commercialExisting.currency = "sar";
	const guard = directHotelRunnerEmailCommercialGuard({
		normalized,
		existing: commercialExisting,
		hotelDetails: hotel,
		matchedReservationBy: ["otaIdentityKey"],
		evidence,
	});
	if (
		guard?.ok !== true ||
		guard.reportedTotalRole !== "payout" ||
		round2(guard?.hotelRunnerReportedTotal) !==
			target.hotelRunnerReportedSourceAmount
	) {
		fail(
			`The exact shared commercial guard rejected HotelRunner payout corroboration: ${clean(
				guard?.reason
			) || "unknown"} (role=${clean(guard?.reportedTotalRole)}, total=${clean(
				guard?.hotelRunnerReportedTotal
			)}).`
		);
	}
	const set = directHotelRunnerCommercialEnrichmentSet(normalized, evidence, {
		reportedTotalRole: "payout",
		existing: commercialExisting,
		commercialPricing: guard.commercialPricing,
	});
	if (!set) fail("The shared commercial projector did not produce an exact update set.");
	const keys = Object.keys(set).sort();
	const allowed = Array.from(ALLOWED_COMMERCIAL_SET_KEYS).sort();
	if (
		keys.length !== allowed.length ||
		keys.some((key, index) => key !== allowed[index])
	) {
		const missing = allowed.filter((key) => !keys.includes(key));
		const unexpected = keys.filter((key) => !allowed.includes(key));
		fail(
			`The shared commercial projector changed its bounded mutation surface (missing: ${missing.join(",") || "none"}; unexpected: ${unexpected.join(",") || "none"}).`
		);
	}
	if (
		set["supplierData.otaCommercialEvidence"]?.evidenceHash !==
			target.otaCommercialEvidenceHash ||
		set["supplierData.hotelRunnerEmailCommercialEvidence"]?.evidenceHash !==
			evidence.evidenceHash
	) {
		fail(
			"The independently recomputed legacy and provider-neutral evidence hashes changed."
		);
	}
	const repairAudit = {
		action: "commercial_materialization_repair",
		repairId: REPAIR_ID,
		otaBookingId: target.otaBookingId,
		directInboundEmailId: target.directInboundEmailId,
		hotelRunnerInboundEmailId: target.hotelRunnerInboundEmailId,
		eventId: target.eventId,
		mirrorId: target.mirrorId,
		releaseSha: lower(releaseSha),
		at: new Date(repairAt),
		vendorApiCalls: 0,
	};
	const update = {
		$set: {
			...set,
			currency: "sar",
			reservationAuditLog: [
				...(Array.isArray(reservation.reservationAuditLog)
					? cloneBson(reservation.reservationAuditLog)
					: []),
				repairAudit,
			],
			updatedAt: new Date(repairAt),
		},
		$inc: { __v: 1 },
	};
	const expected = applyUpdateToDocument(reservation, update);
	assertReservationBoundary(target, expected, { applied: true, releaseSha });
	assertCommercialProjection(target, expected, evidence);
	if (
		canonicalEjsonSha256(protectedReservationSnapshot(expected)) !==
		canonicalEjsonSha256(protectedReservationSnapshot(reservation))
	) {
		fail(
			"The repair would change protected guest, lifecycle, review, payment, VCC, settlement, root, room allocation, HotelRunner source, or pre-existing audit state."
		);
	}
	return { normalized, evidence, guard, set, update, expected };
}

function appliedReservation(target, reservation, { releaseSha = "" } = {}) {
	try {
		assertReservationBoundary(target, reservation, { applied: true, releaseSha });
		const marker = assertCommercialProjection(target, reservation);
		if (Number(reservation.__v) !== target.reservationVersion + 1) return null;
		return marker;
	} catch (_error) {
		return null;
	}
}
async function loadScope({
	target = TARGET,
	repairAt,
	releaseSha = "",
	models = {},
} = {}) {
	const ReservationModel = models.ReservationModel || Reservations;
	const EventModel = models.EventModel || HotelRunnerEvent;
	const MirrorModel = models.MirrorModel || HotelRunnerReservation;
	const InboundModel = models.InboundModel || InboundEmail;
	const HotelModel = models.HotelModel || HotelDetails;
	const reservations = await leanMany(ReservationModel, reservationLookup(target), {
		limit: 3,
	});
	const events = await leanMany(EventModel, eventLookup(target), {
		select: "+payload +integrityConflicts",
		limit: 3,
	});
	const mirrors = await leanMany(MirrorModel, mirrorLookup(target), {
		select: "+normalizedSnapshot +lastAppliedProjection",
		limit: 3,
	});
	const audits = await leanMany(InboundModel, inboundLookup(target), { limit: 4 });
	const hotel = await leanOne(HotelModel, { _id: target.hotelId });
	if (reservations.length !== 1 || events.length !== 1 || mirrors.length !== 1) {
		fail(
			`Exact Agoda scope must be one reservation/event/mirror; found ${reservations.length}/${events.length}/${mirrors.length}.`,
			"AGODA_2039878308_REPAIR_SCOPE_INVALID"
		);
	}
	const auditIds = new Set(audits.map((audit) => clean(audit?._id)));
	if (
		audits.length !== 2 ||
		!auditIds.has(target.directInboundEmailId) ||
		!auditIds.has(target.hotelRunnerInboundEmailId)
	) {
		fail(`Exact Agoda scope must contain only the two audited inbound messages; found ${audits.length}.`);
	}
	const directAudit = audits.find(
		(audit) => clean(audit?._id) === target.directInboundEmailId
	);
	const hotelRunnerAudit = audits.find(
		(audit) => clean(audit?._id) === target.hotelRunnerInboundEmailId
	);
	const reservation = reservations[0];
	const event = events[0];
	const mirror = mirrors[0];
	assertHotel(target, hotel);
	assertEvent(target, event);
	assertMirror(target, mirror);
	assertInbound(target, directAudit, "direct_agoda_email_evidence");
	assertInbound(target, hotelRunnerAudit, "hotelrunner_email_evidence");
	const appliedMarker = appliedReservation(target, reservation, { releaseSha });
	if (appliedMarker) {
		return {
			target,
			state: "already_applied",
			reservation,
			event,
			mirror,
			directAudit,
			hotelRunnerAudit,
			hotel,
			evidence: appliedMarker,
			protectedHash: canonicalEjsonSha256(
				protectedReservationSnapshot(reservation)
			),
		};
	}
	assertReservationBoundary(target, reservation);
	const built = buildExpectedReservation(
		target,
		reservation,
		directAudit,
		new Date(repairAt),
		{ hotel, releaseSha }
	);
	return {
		target,
		state: "ready",
		reservation,
		event,
		mirror,
		directAudit,
		hotelRunnerAudit,
		hotel,
		...built,
		originalHash: canonicalEjsonSha256(reservation),
		expectedHash: canonicalEjsonSha256(built.expected),
		protectedHash: canonicalEjsonSha256(
			protectedReservationSnapshot(reservation)
		),
	};
}

function proofBasis(scope, releaseSha, repairAt, execution) {
	return {
		version: 1,
		repairId: REPAIR_ID,
		releaseSha: lower(releaseSha),
		applyStrategy: APPLY_STRATEGY,
		repairAt: new Date(repairAt).toISOString(),
		execution: {
			treeSha: execution.treeSha,
			executionFingerprint: execution.executionFingerprint,
			trackedWorktreeClean: execution.trackedWorktreeClean,
		},
		target: {
			key: scope.target.key,
			reservationMongoId: scope.target.reservationMongoId,
			otaBookingId: scope.target.otaBookingId,
			hotelId: scope.target.hotelId,
		},
		immutable: {
			reservationOriginalHash: scope.originalHash,
			reservationExpectedHash: scope.expectedHash,
			reservationProtectedHash: scope.protectedHash,
			eventHash: scope.target.eventDocumentHash,
			mirrorHash: scope.target.mirrorDocumentHash,
			directInboundHash: scope.target.directInboundDocumentHash,
			hotelRunnerInboundHash: scope.target.hotelRunnerInboundDocumentHash,
			directBodyHash: scope.target.directInboundBodyHash,
			directSourceTextHash: scope.target.directSourceTextHash,
			legacyEvidenceHash: scope.evidence?.evidenceHash || "",
			otaCommercialEvidenceHash: scope.target.otaCommercialEvidenceHash,
			plannedSetHash: canonicalEjsonSha256(scope.set || {}),
		},
	};
}

async function loadPlan({
	target = TARGET,
	repairAt,
	releaseSha,
	execution,
	models = {},
} = {}) {
	const verifiedExecution = assertExecution(execution, releaseSha);
	const scope = await loadScope({ target, repairAt, releaseSha, models });
	if (scope.state === "already_applied") {
		return {
			repairId: REPAIR_ID,
			releaseSha: lower(releaseSha),
			repairAt: new Date(repairAt),
			execution: verifiedExecution,
			state: "already_applied",
			scope,
			planHash: "",
		};
	}
	const basis = proofBasis(scope, releaseSha, repairAt, verifiedExecution);
	return {
		repairId: REPAIR_ID,
		releaseSha: lower(releaseSha),
		repairAt: new Date(repairAt),
		execution: verifiedExecution,
		state: "ready",
		scope,
		basis,
		planHash: canonicalEjsonSha256(basis),
	};
}

function proofToken(plan) {
	if (plan.state !== "ready") return "";
	return `${plan.repairAt.getTime()}.${plan.planHash}`;
}

function backupRecord(plan, role, document) {
	const basis = {
		_id: `${REPAIR_ID}:${role}`,
		repairId: REPAIR_ID,
		role,
		documentId: clean(document?._id),
		originalHash: canonicalEjsonSha256(document),
		backedUpAt: plan.repairAt,
		originalDocument: cloneBson(document),
	};
	return { ...basis, recordHash: canonicalEjsonSha256(basis) };
}

function backupRecordsForPlan(plan) {
	if (plan.state !== "ready") {
		fail("Only an exact ready plan can build a durable backup set.");
	}
	const scope = plan.scope;
	return [
		backupRecord(plan, "reservation_before", scope.reservation),
		backupRecord(plan, "hotelrunner_event_evidence", scope.event),
		backupRecord(plan, "hotelrunner_mirror_evidence", scope.mirror),
		backupRecord(plan, "direct_agoda_email_evidence", scope.directAudit),
		backupRecord(plan, "hotelrunner_email_evidence", scope.hotelRunnerAudit),
	];
}

function verifyBackupRecords(records, manifest = null, target = TARGET) {
	if (!Array.isArray(records) || records.length !== BACKUP_ROLES.length) {
		fail("The permanent Agoda backup set is incomplete.", "AGODA_2039878308_REPAIR_BACKUP_INVALID");
	}
	const byRole = new Map();
	for (const record of records) {
		const { recordHash, ...basis } = record || {};
		if (
			clean(record?.repairId) !== REPAIR_ID ||
			!BACKUP_ROLES.includes(record?.role) ||
			byRole.has(record.role) ||
			canonicalEjsonSha256(basis) !== recordHash ||
			canonicalEjsonSha256(record.originalDocument) !== record.originalHash
		) {
			fail("A permanent Agoda backup record failed integrity.", "AGODA_2039878308_REPAIR_BACKUP_INVALID");
		}
		byRole.set(record.role, record);
	}
	const expectedIds = {
		reservation_before: target.reservationMongoId,
		hotelrunner_event_evidence: target.eventId,
		hotelrunner_mirror_evidence: target.mirrorId,
		direct_agoda_email_evidence: target.directInboundEmailId,
		hotelrunner_email_evidence: target.hotelRunnerInboundEmailId,
	};
	for (const [role, documentId] of Object.entries(expectedIds)) {
		if (clean(byRole.get(role)?.documentId) !== documentId) {
			fail("A permanent Agoda backup role is bound to the wrong document.");
		}
	}
	const backupSetSha256 = canonicalEjsonSha256(
		BACKUP_ROLES.map((role) => ({ role, recordHash: byRole.get(role).recordHash }))
	);
	if (manifest) {
		if (
			manifest.backupSetSha256 !== backupSetSha256 ||
			Number(manifest.backupRecordCount) !== BACKUP_ROLES.length ||
			BACKUP_ROLES.some(
				(role) => manifest.backupRecordHashes?.[role] !== byRole.get(role).recordHash
			)
		) {
			fail("The Agoda manifest no longer binds its immutable backup set.");
		}
	}
	return { byRole, backupSetSha256 };
}

function manifestForPlan(plan, records) {
	const verified = verifyBackupRecords(records, null, plan.scope.target);
	const document = {
		_id: REPAIR_ID,
		repairId: REPAIR_ID,
		version: 1,
		state: "backing_up",
		releaseSha: plan.releaseSha,
		treeSha: plan.execution.treeSha,
		executionFingerprint: plan.execution.executionFingerprint,
		applyStrategy: APPLY_STRATEGY,
		proofPlannedAt: plan.repairAt,
		planHash: plan.planHash,
		targetKey: plan.scope.target.key,
		reservationMongoId: plan.scope.target.reservationMongoId,
		otaBookingId: plan.scope.target.otaBookingId,
		hotelId: plan.scope.target.hotelId,
		backupCollection: BACKUP_COLLECTION,
		backupRecordCount: records.length,
		backupRecordHashes: Object.fromEntries(
			records.map((record) => [record.role, record.recordHash])
		),
		backupSetSha256: verified.backupSetSha256,
		originalHash: plan.scope.originalHash,
		expectedRepairedHash: plan.scope.expectedHash,
		protectedHash: plan.scope.protectedHash,
		legacyEvidenceHash: plan.scope.evidence.evidenceHash,
		otaCommercialEvidenceHash: plan.scope.target.otaCommercialEvidenceHash,
		directInboundDocumentHash: plan.scope.target.directInboundDocumentHash,
		hotelRunnerInboundDocumentHash:
			plan.scope.target.hotelRunnerInboundDocumentHash,
		eventDocumentHash: plan.scope.target.eventDocumentHash,
		mirrorDocumentHash: plan.scope.target.mirrorDocumentHash,
		vendorApiCalls: 0,
	};
	return { ...document, manifestBasisHash: canonicalEjsonSha256(document) };
}

function assertManifestPlan(manifest, expected) {
	const mutableKeys = new Set([
		"state",
		"backedUpAt",
		"applyingAt",
		"applyAttemptNumber",
		"applyOwnerToken",
		"appliedAt",
		"appliedDocumentHash",
		"postverifiedAt",
		"compensatedAt",
		"compensationReasonCode",
		"compensationDocumentHash",
		"compensationWritePerformed",
		"compensationAcknowledgementRecovered",
		"manualInterventionAt",
		"manualInterventionReasonCode",
		"manualInterventionObservedHash",
	]);
	const strip = (value) => {
		const next = cloneBson(value || {});
		for (const key of mutableKeys) delete next[key];
		return next;
	};
	if (
		!manifest ||
		![...MANIFEST_ACTIONABLE_STATES, "manual_intervention_required"].includes(
			manifest.state
		) ||
		canonicalEjsonSha256(strip(manifest)) !== canonicalEjsonSha256(strip(expected))
	) {
		fail("An existing Agoda manifest conflicts with the approved plan.");
	}
}

async function insertImmutable(collection, document, capability, plan) {
	const existing = await collection.findOne({ _id: document._id });
	if (existing) {
		if (canonicalEjsonSha256(existing) !== canonicalEjsonSha256(document)) {
			fail("An immutable Agoda repair artifact already exists with different content.");
		}
		return existing;
	}
	let insertionError = null;
	assertMutationCapability(capability, plan);
	try {
		await collection.insertOne(cloneBson(document), {
			writeConcern: { w: "majority" },
		});
	} catch (error) {
		insertionError = error;
	}
	const observed = await collection.findOne({ _id: document._id });
	if (observed && canonicalEjsonSha256(observed) === canonicalEjsonSha256(document)) {
		return observed;
	}
	const error = new Error(
		`Durable Agoda artifact insertion did not commit${
			insertionError ? `: ${insertionError.message}` : "."
		}`
	);
	error.code = "AGODA_2039878308_REPAIR_BACKUP_WRITE_FAILED";
	throw error;
}

async function ensureDurableBackup(plan, db, { capability } = {}) {
	if (!db || typeof db.collection !== "function") {
		fail("A MongoDB database handle is required for the durable backup.");
	}
	const backups = db.collection(BACKUP_COLLECTION);
	const manifests = db.collection(MANIFEST_COLLECTION);
	const records = backupRecordsForPlan(plan);
	const expectedManifest = manifestForPlan(plan, records);
	let manifest = await manifests.findOne({ _id: REPAIR_ID });
	if (!manifest) {
		manifest = await insertImmutable(
			manifests,
			expectedManifest,
			capability,
			plan
		);
	}
	assertManifestPlan(manifest, expectedManifest);
	for (const record of records) {
		await insertImmutable(backups, record, capability, plan);
	}
	const observedRecords = await backups
		.find({ repairId: REPAIR_ID })
		.sort({ role: 1 })
		.toArray();
	verifyBackupRecords(observedRecords, null, plan.scope.target);
	if (manifest.state === "backing_up") {
		assertMutationCapability(capability, plan);
		const result = await manifests.updateOne(
			{
				_id: REPAIR_ID,
				state: "backing_up",
				planHash: plan.planHash,
				backupSetSha256: expectedManifest.backupSetSha256,
			},
			{ $set: { state: "backed_up", backedUpAt: new Date(plan.repairAt) } },
			{ writeConcern: { w: "majority" } }
		);
		if (Number(result?.matchedCount ?? result?.n ?? 0) !== 1) {
			fail("The manifest backup-finalization CAS was rejected.");
		}
		manifest = await manifests.findOne({ _id: REPAIR_ID });
	}
	if (manifest?.state !== "backed_up") {
		fail("The durable backup manifest is not fully backed up.");
	}
	assertManifestPlan(manifest, expectedManifest);
	verifyBackupRecords(observedRecords, manifest, plan.scope.target);
	return { manifest, records: observedRecords, expectedManifest };
}

async function loadDurableBackup(db, target = TARGET) {
	if (!db || typeof db.collection !== "function") {
		fail("A MongoDB database handle is required for backup verification.");
	}
	const manifest = await db.collection(MANIFEST_COLLECTION).findOne({ _id: REPAIR_ID });
	const records = await db
		.collection(BACKUP_COLLECTION)
		.find({ repairId: REPAIR_ID })
		.sort({ role: 1 })
		.toArray();
	if (!manifest) fail("The durable Agoda repair manifest is missing.");
	const verified = verifyBackupRecords(records, manifest, target);
	return { manifest, records, ...verified };
}

async function readReservation(collection, id) {
	return collection.findOne(
		{ _id: cloneBson(id) },
		{ readPreference: "primary", readConcern: { level: "majority" } }
	);
}

async function replaceReservationOnce(
	collection,
	original,
	expected,
	capability,
	plan
) {
	const beforeHash = canonicalEjsonSha256(original);
	const afterHash = canonicalEjsonSha256(expected);
	let acknowledgementError = null;
	assertMutationCapability(capability, plan);
	try {
		const result = await collection.replaceOne(
			buildExactCasFilter(original),
			cloneBson(expected),
			{ writeConcern: { w: "majority" } }
		);
		const matched = Number(result?.matchedCount ?? result?.n ?? 0);
		const modified = Number(result?.modifiedCount ?? result?.nModified ?? 0);
		if (result?.acknowledged === false || matched !== 1 || modified !== 1) {
			throw new Error("The full-document Agoda CAS did not replace exactly one reservation.");
		}
	} catch (error) {
		acknowledgementError = error;
	}
	const observed = await readReservation(collection, original._id);
	const observedHash = observed ? canonicalEjsonSha256(observed) : "";
	if (observedHash === afterHash) {
		return { document: observed, acknowledgementLost: Boolean(acknowledgementError) };
	}
	if (observedHash === beforeHash) {
		const error = new Error(
			`The Agoda CAS did not commit${
				acknowledgementError ? `: ${acknowledgementError.message}` : "."
			}`
		);
		error.code = "AGODA_2039878308_REPAIR_CAS_REJECTED";
		throw error;
	}
	const error = new Error(
		"The Agoda CAS is ambiguous: the live reservation is neither the exact before nor exact after document."
	);
	error.code = "AGODA_2039878308_REPAIR_MANUAL_INTERVENTION_REQUIRED";
	throw error;
}

async function beginManifestApply(
	db,
	manifest,
	plan,
	ownerToken,
	capability
) {
	if (!/^[a-f0-9]{64}$/.test(lower(ownerToken))) {
		fail("A unique Agoda apply owner token is required.");
	}
	if (manifest.state === "applying") {
		if (manifest.applyOwnerToken === ownerToken) return manifest;
		fail(
			"Another Agoda repair execution owns the applying manifest.",
			"AGODA_2039878308_REPAIR_APPLY_ALREADY_OWNED"
		);
	}
	if (manifest.state !== "backed_up") {
		fail(
			`The Agoda manifest is not actionable from state ${clean(manifest.state) || "missing"}.`,
			"AGODA_2039878308_REPAIR_MANIFEST_STATE_INVALID"
		);
	}
	const collection = db.collection(MANIFEST_COLLECTION);
	const attemptNumber = Number(manifest.applyAttemptNumber || 0) + 1;
	assertMutationCapability(capability, plan);
	const result = await collection.updateOne(
		{
			_id: REPAIR_ID,
			state: "backed_up",
			planHash: plan.planHash,
			backupSetSha256: manifest.backupSetSha256,
			originalHash: plan.scope.originalHash,
			expectedRepairedHash: plan.scope.expectedHash,
		},
		{
			$set: {
				state: "applying",
				applyingAt: new Date(plan.repairAt),
				applyAttemptNumber: attemptNumber,
				applyOwnerToken: ownerToken,
			},
		},
		{ writeConcern: { w: "majority" } }
	);
	const matched = Number(result?.matchedCount ?? result?.n ?? 0);
	const observed = await collection.findOne({ _id: REPAIR_ID });
	if (
		matched !== 1 &&
		!(
			observed?.state === "applying" &&
			observed.planHash === plan.planHash &&
			observed.applyOwnerToken === ownerToken &&
			Number(observed.applyAttemptNumber) === attemptNumber
		)
	) {
		fail("The Agoda manifest applying-state CAS was rejected.");
	}
	if (
		observed?.state !== "applying" ||
		observed.planHash !== plan.planHash ||
		observed.applyOwnerToken !== ownerToken ||
		observed.originalHash !== plan.scope.originalHash ||
		observed.expectedRepairedHash !== plan.scope.expectedHash ||
		Number(observed.applyAttemptNumber) !== attemptNumber
	) {
		fail("The Agoda manifest applying state could not be verified.");
	}
	return observed;
}

async function classifyLiveReservation(collection, plan) {
	const document = await readReservation(collection, plan.scope.reservation._id);
	const hash = document ? canonicalEjsonSha256(document) : "";
	if (hash === plan.scope.originalHash) return { state: "original", document, hash };
	if (hash === plan.scope.expectedHash) return { state: "expected", document, hash };
	return { state: document ? "foreign" : "missing", document, hash };
}

async function markManifestManualIntervention(
	db,
	manifest,
	plan,
	observedHash,
	reasonCode,
	ownerToken,
	capability
) {
	const collection = db.collection(MANIFEST_COLLECTION);
	assertMutationCapability(capability, plan);
	try {
		await collection.updateOne(
			{
				_id: REPAIR_ID,
				state: "applying",
				planHash: plan.planHash,
				backupSetSha256: manifest.backupSetSha256,
				applyOwnerToken: ownerToken,
			},
			{
				$set: {
					state: "manual_intervention_required",
					manualInterventionAt: new Date(),
					manualInterventionReasonCode: clean(reasonCode).slice(0, 100),
					manualInterventionObservedHash: lower(observedHash),
				},
			},
			{ writeConcern: { w: "majority" } }
		);
	} catch (_error) {
		// The reservation remains untouched when its exact hash is foreign. The
		// permanent backup still provides the operator with the recovery source.
	}
}

async function markManifestCompensated(
	db,
	manifest,
	plan,
	{
		reasonCode,
		writePerformed,
		acknowledgementRecovered,
		ownerToken,
		capability,
		compensatedAt = new Date(),
	}
) {
	const collection = db.collection(MANIFEST_COLLECTION);
	const fields = {
		state: "backed_up",
		compensatedAt,
		compensationReasonCode: clean(reasonCode).slice(0, 100),
		compensationDocumentHash: plan.scope.originalHash,
		compensationWritePerformed: writePerformed === true,
		compensationAcknowledgementRecovered:
			acknowledgementRecovered === true,
	};
	assertMutationCapability(capability, plan);
	const result = await collection.updateOne(
		{
			_id: REPAIR_ID,
			state: "applying",
			planHash: plan.planHash,
			backupSetSha256: manifest.backupSetSha256,
			applyOwnerToken: ownerToken,
			originalHash: plan.scope.originalHash,
			expectedRepairedHash: plan.scope.expectedHash,
		},
		{ $set: fields },
		{ writeConcern: { w: "majority" } }
	);
	const matched = Number(result?.matchedCount ?? result?.n ?? 0);
	const observed = await collection.findOne({ _id: REPAIR_ID });
	if (
		matched !== 1 &&
		!(
			observed?.state === "backed_up" &&
			observed.planHash === plan.planHash &&
			observed.compensationDocumentHash === plan.scope.originalHash
		)
	) {
		fail(
			"The Agoda reservation was restored but its compensation manifest transition is unresolved.",
			"AGODA_2039878308_REPAIR_COMPENSATION_MANIFEST_UNRESOLVED"
		);
	}
	if (
		observed?.state !== "backed_up" ||
		observed.planHash !== plan.planHash ||
		observed.compensationDocumentHash !== plan.scope.originalHash
	) {
		fail(
			"The Agoda reservation was restored but the compensated manifest could not be verified.",
			"AGODA_2039878308_REPAIR_COMPENSATION_MANIFEST_UNRESOLVED"
		);
	}
	return observed;
}

async function compensateReservation({
	db,
	collection,
	manifest,
	plan,
	cause,
	ownerToken,
	capability,
}) {
	let classification = await classifyLiveReservation(collection, plan);
	let writePerformed = false;
	let acknowledgementRecovered = false;
	if (classification.state === "expected") {
		const resolution = await replaceReservationOnce(
			collection,
			plan.scope.expected,
			plan.scope.reservation,
			capability,
			plan
		);
		writePerformed = true;
		acknowledgementRecovered = resolution.acknowledgementLost === true;
		classification = await classifyLiveReservation(collection, plan);
	}
	if (classification.state !== "original") {
		await markManifestManualIntervention(
			db,
			manifest,
			plan,
			classification.hash,
			cause?.code || "AGODA_2039878308_REPAIR_COMPENSATION_BLOCKED",
			ownerToken,
			capability
		);
		const error = new Error(
			"Standalone compensation stopped because the live Agoda reservation is not the exact original or expected document."
		);
		error.code = "AGODA_2039878308_REPAIR_MANUAL_INTERVENTION_REQUIRED";
		error.observedHash = classification.hash;
		error.cause = cause;
		throw error;
	}
	await markManifestCompensated(db, manifest, plan, {
		reasonCode: cause?.code || "AGODA_2039878308_REPAIR_APPLY_FAILED",
		writePerformed,
		acknowledgementRecovered,
		ownerToken,
		capability,
	});
	return { writePerformed, acknowledgementRecovered };
}

async function markManifestApplied(
	db,
	manifest,
	plan,
	expectedHash,
	appliedAt,
	ownerToken = "",
	capability
) {
	if (manifest.state === "applied") {
		if (manifest.appliedDocumentHash !== expectedHash) {
			fail("Applied Agoda manifest hash is inconsistent.");
		}
		return manifest;
	}
	const collection = db.collection(MANIFEST_COLLECTION);
	const stateFilter = ownerToken
		? { state: "applying", applyOwnerToken: ownerToken }
		: { state: { $in: ["backed_up", "applying"] } };
	assertMutationCapability(capability, plan);
	const result = await collection.updateOne(
		{
			_id: REPAIR_ID,
			...stateFilter,
			planHash: manifest.planHash,
			backupSetSha256: manifest.backupSetSha256,
			expectedRepairedHash: expectedHash,
		},
		{
			$set: {
				state: "applied",
				appliedAt,
				appliedDocumentHash: expectedHash,
				postverifiedAt: appliedAt,
			},
		},
		{ writeConcern: { w: "majority" } }
	);
	const matched = Number(result?.matchedCount ?? result?.n ?? 0);
	if (matched !== 1) {
		const observed = await collection.findOne({ _id: REPAIR_ID });
		if (
			observed?.state === "applied" &&
			observed.appliedDocumentHash === expectedHash
		) {
			return observed;
		}
		fail("The Agoda manifest applied-state CAS was rejected.");
	}
	const observed = await collection.findOne({ _id: REPAIR_ID });
	if (
		observed?.state !== "applied" ||
		observed.appliedDocumentHash !== expectedHash
	) {
		fail("The Agoda manifest applied state could not be verified.");
	}
	return observed;
}

async function applyPlan(plan, { db, models = {}, capability } = {}) {
	assertMutationCapability(capability, plan, { mutationBoundary: false });
	const ReservationCollection =
		models.ReservationCollection ||
		(models.ReservationModel || Reservations)?.collection;
	if (
		!ReservationCollection ||
		typeof ReservationCollection.findOne !== "function" ||
		typeof ReservationCollection.replaceOne !== "function"
	) {
		fail("The raw reservation collection is required for full-document CAS.");
	}
	if (plan.state === "already_applied") {
		const backup = await loadDurableBackup(db, plan.scope.target);
		const original = backup.byRole.get("reservation_before")?.originalDocument;
		if (
			!original ||
			canonicalEjsonSha256(protectedReservationSnapshot(original)) !==
				plan.scope.protectedHash ||
			!MANIFEST_ACTIONABLE_STATES.includes(backup.manifest.state)
		) {
			fail("Already-applied Agoda state is not bound to its exact permanent backup.");
		}
		const liveHash = canonicalEjsonSha256(plan.scope.reservation);
		if (backup.manifest.expectedRepairedHash !== liveHash) {
			fail("Already-applied Agoda reservation differs from its durable manifest.");
		}
		await markManifestApplied(
			db,
			backup.manifest,
			plan,
			liveHash,
			plan.scope.evidence.appliedAt || plan.repairAt,
			"",
			capability
		);
		return { state: "already_applied", changed: 0, vendorApiCalls: 0 };
	}
	const backup = await ensureDurableBackup(plan, db, { capability });
	const writeFence = await loadPlan({
		target: plan.scope.target,
		repairAt: plan.repairAt,
		releaseSha: plan.releaseSha,
		execution: plan.execution,
		models,
	});
	if (
		writeFence.state !== "ready" ||
		writeFence.planHash !== plan.planHash ||
		writeFence.scope.originalHash !== plan.scope.originalHash ||
		writeFence.scope.expectedHash !== plan.scope.expectedHash
	) {
		fail("The exact Agoda scope changed after permanent backup and before apply.");
	}
	const ownerToken = crypto.randomBytes(32).toString("hex");
	let applyingManifest = await beginManifestApply(
		db,
		backup.manifest,
		plan,
		ownerToken,
		capability
	);
	let resolution = { acknowledgementLost: false };
	try {
		const beforeWrite = await classifyLiveReservation(
			ReservationCollection,
			plan
		);
		if (beforeWrite.state === "original") {
			resolution = await replaceReservationOnce(
				ReservationCollection,
				plan.scope.reservation,
				plan.scope.expected,
				capability,
				plan
			);
		} else if (beforeWrite.state !== "expected") {
			const error = new Error(
				"The Agoda reservation changed after its write fence and before full-document CAS."
			);
			error.code = "AGODA_2039878308_REPAIR_MANUAL_INTERVENTION_REQUIRED";
			error.observedHash = beforeWrite.hash;
			throw error;
		}
		const verifiedPlan = await loadPlan({
			target: plan.scope.target,
			repairAt: plan.repairAt,
			releaseSha: plan.releaseSha,
			execution: plan.execution,
			models,
		});
		if (
			verifiedPlan.state !== "already_applied" ||
			canonicalEjsonSha256(verifiedPlan.scope.reservation) !==
				plan.scope.expectedHash ||
			verifiedPlan.scope.protectedHash !== plan.scope.protectedHash
		) {
			fail("Post-CAS Agoda verification did not prove the exact protected result.");
		}
		await markManifestApplied(
			db,
			applyingManifest,
			plan,
			plan.scope.expectedHash,
			plan.repairAt,
			ownerToken,
			capability
		);
		return {
			state: "applied",
			changed: beforeWrite.state === "original" ? 1 : 0,
			acknowledgementRecovered: resolution.acknowledgementLost,
			vendorApiCalls: 0,
		};
	} catch (error) {
		const observedManifest = await db
			.collection(MANIFEST_COLLECTION)
			.findOne({ _id: REPAIR_ID });
		const observedReservation = await classifyLiveReservation(
			ReservationCollection,
			plan
		);
		if (
			observedManifest?.state === "applied" &&
			observedManifest.appliedDocumentHash === plan.scope.expectedHash &&
			observedReservation.state === "expected"
		) {
			return {
				state: "applied",
				changed: 1,
				acknowledgementRecovered: true,
				vendorApiCalls: 0,
			};
		}
		if (observedManifest?.state === "applying") {
			applyingManifest = observedManifest;
		}
		try {
			await compensateReservation({
				db,
				collection: ReservationCollection,
				manifest: applyingManifest,
				plan,
				cause: error,
				ownerToken,
				capability,
			});
		} catch (compensationError) {
			compensationError.applyCause = error;
			throw compensationError;
		}
		error.compensated = true;
		throw error;
	}
}

function sanitizedOutput(plan, mode, proof = "") {
	const target = plan.scope.target;
	return {
		mode,
		repairId: REPAIR_ID,
		releaseSha: plan.releaseSha,
		applyStrategy: APPLY_STRATEGY,
		state: plan.state,
		proof: mode === "dry_run" && plan.state === "ready" ? proof : undefined,
		proofExpiresInMinutes:
			mode === "dry_run" && plan.state === "ready"
				? PROOF_MAX_AGE_MS / 60_000
				: undefined,
		targetCount: 1,
		target: {
			otaBookingId: target.otaBookingId,
			reservationMongoId: target.reservationMongoId,
			stay: [target.checkinDate, target.checkoutDate],
			currency: target.propertyCurrency,
			guestGross: target.grossTotalSar,
			hotelPayout: target.payoutTotalSar,
			otaDeduction: target.otaExpenseTotalSar,
			explicitOtaCommission: target.otaCommissionSar,
			protectedRoot: target.rootTotalSar,
			platformMargin: target.platformMarginSar,
			source: {
				currency: target.sourceCurrency,
				guestGross: target.sourceGross,
				hotelPayout: target.sourcePayout,
				hotelRunnerReportedAmount: target.hotelRunnerReportedSourceAmount,
			},
		},
		backupCollection: BACKUP_COLLECTION,
		manifestCollection: MANIFEST_COLLECTION,
		mutatesReservationCount: 1,
		createsReservations: false,
		mutatesLifecycleGuestReviewPaymentVccSettlementRoot: false,
		appendsIncidentRepairAudit: true,
		mutatesHotelRunnerEventMirrorOrInboundAudit: false,
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
		attestExecution = attestExecutionCheckout,
		models = {},
		db: injectedDb = null,
	} = {}
) {
	const options = parseArguments(argv);
	const execution = assertExecution(
		attestExecution({ releaseSha: options.releaseSha }),
		options.releaseSha
	);
	const now = clock();
	const proofDetails = options.apply ? parseProof(options.proof, now) : null;
	const repairAt = proofDetails?.plannedAt || now;
	const database =
		process.env.DATABASE || process.env.MONGO_URI || process.env.MONGODB_URI;
	if (!database && !models.skipConnect) fail("Missing DATABASE/MONGO connection string.");
	let connectedHere = false;
	try {
		if (!models.skipConnect) {
			await connect(database);
			connectedHere = true;
		}
		const db = injectedDb || mongoose.connection.db;
		const plan = await loadPlan({
			target: models.target || TARGET,
			repairAt,
			releaseSha: options.releaseSha,
			execution,
			models,
		});
		const generatedProof = proofToken(plan);
		if (
			options.apply &&
			plan.state === "ready" &&
			(proofDetails.planHash !== plan.planHash || options.proof !== generatedProof)
		) {
			fail("The live exact scope does not match the supplied dry-run proof.", "AGODA_2039878308_REPAIR_PROOF_MISMATCH");
		}
		if (plan.state === "already_applied") {
			await loadDurableBackup(db, plan.scope.target);
		}
		console.log(
			JSON.stringify(
				sanitizedOutput(plan, options.apply ? "apply" : "dry_run", generatedProof),
				null,
				2
			)
		);
		if (!options.apply) {
			return {
				state:
					plan.state === "already_applied"
						? "already_applied"
						: "dry_run_ready",
				plan,
				proof: generatedProof,
			};
		}
		if (plan.state === "already_applied") {
			return { state: "already_applied", changed: 0, vendorApiCalls: 0 };
		}
		const capability = createMutationCapability({
			plan,
			proofDetails,
			execution,
			clock,
		});
		const result = await applyPlan(plan, { db, models, capability });
		console.log(
			JSON.stringify(
				{
					state: result.state,
					repairId: REPAIR_ID,
					releaseSha: plan.releaseSha,
					changed: result.changed,
					acknowledgementRecovered:
						result.acknowledgementRecovered === true,
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
		console.error("[agoda-2039878308-commercial-repair] stopped", {
			code: clean(error?.code || "AGODA_2039878308_COMMERCIAL_REPAIR_FAILED").slice(0, 100),
			message: clean(error?.message || "Unknown repair failure").slice(0, 500),
		});
		process.exitCode = 1;
	});
}

module.exports = {
	APPLY_STRATEGY,
	BACKUP_COLLECTION,
	BACKUP_ROLES,
	MANIFEST_ACTIONABLE_STATES,
	MANIFEST_COLLECTION,
	PROOF_MAX_AGE_MS,
	REPAIR_ID,
	TARGET,
	applyPlan,
	assertCommercialProjection,
	assertExecution,
	assertMutationCapability,
	assertRelease,
	attestExecutionCheckout,
	backupRecordsForPlan,
	beginManifestApply,
	buildExpectedReservation,
	currentReleaseSha,
	classifyLiveReservation,
	compensateReservation,
	createMutationCapability,
	ensureDurableBackup,
	loadDurableBackup,
	loadPlan,
	loadScope,
	main,
	manifestForPlan,
	normalizedFromAudit,
	parseArguments,
	parseProof,
	proofToken,
	protectedReservationSnapshot,
	replaceReservationOnce,
	reservationLookup,
	sha256,
	trustedExchangeEvidence,
	verifyBackupRecords,
};
