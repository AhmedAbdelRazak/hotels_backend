/** @format */

"use strict";

/**
 * Incident-only commercial materialization for two audited, already-paid Agoda
 * reservations received on 2026-08-09.
 *
 * The shared direct-email guard correctly rejects these records as
 * `protected_state`. This script does not weaken that runtime guard. Instead it
 * proves the two exact reservation/source envelopes, rebuilds the authenticated
 * Agoda evidence with the shared parser, seeds the shared pricing mapper with
 * the exact HotelRunner mirror payout nights, and permits only the resulting
 * commercial fields to differ.
 *
 * Dry run (no database writes):
 *   node scripts/repairAgodaPaidCommercialMaterialization20260809.js \
 *     --release-sha=<exact-approved-merged-sha>
 *
 * Apply requires the exact, unexpired proof emitted by that dry run:
 *   node scripts/repairAgodaPaidCommercialMaterialization20260809.js \
 *     --apply \
 *     --repair-id=agoda-paid-commercial-materialization-20260809-v1 \
 *     --release-sha=<same-exact-approved-merged-sha> \
 *     --proof=<dry-run-proof>
 *
 * This file contains no vendor client and never creates a reservation. The
 * production database is standalone, so apply uses serialized full-document
 * CAS with exact hash readback and reverse-order compensation. Permanent,
 * full-document backups of both reservations and all six immutable evidence
 * documents are completed and hash-verified before the first reservation CAS.
 */

const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const { ObjectId } = require("bson");
const mongoose = require("mongoose");

require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);

const {
  buildDirectHotelRunnerCommercialPricing,
  buildHotelRunnerEmailCommercialEvidence,
  detectConfirmationMatchFields,
  directHotelRunnerCommercialEnrichmentSet,
  directHotelRunnerEmailCommercialGuard,
  extractNormalizedReservation,
  verifiedHotelRunnerEmailCommercialEvidence,
} = require("../services/otaReservationMapper");
const {
  canonicalEjson,
  canonicalEjsonSha256,
  cloneBson,
} = require("../services/tripHotelRunnerRepair20260805");

const REPAIR_ID = "agoda-paid-commercial-materialization-20260809-v1";
const BACKUP_COLLECTION =
  "ota_agoda_paid_commercial_repair_backup_20260809_v1";
const MANIFEST_COLLECTION =
  "ota_agoda_paid_commercial_repair_manifests";
const EXPECTED_HOTEL_ID = "6a40b6a1a6efe70450536038";
const EXPECTED_HOTEL_NAME_KEY = "zadajyad";
const PROOF_MAX_AGE_MS = 30 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 1000;

const COLLECTIONS = Object.freeze({
  reservation: "reservations",
  event: "hotelrunnerevents",
  mirror: "hotelrunnerreservations",
  audit: "inboundemails",
  hotel: "hoteldetails",
});

const EXECUTION_PATHS = Object.freeze([
  "scripts/repairAgodaPaidCommercialMaterialization20260809.js",
  "services/otaReservationMapper.js",
  "services/tripHotelRunnerRepair20260805.js",
]);

const REQUIRED_MATCH_FIELDS = Object.freeze([
  "customer_details.confirmation_number2",
  "otaIdentityKey",
  "reservation_id",
  "supplierData.otaConfirmationNumber",
  "supplierData.platformConfirmationNumber",
  "supplierData.suppliedBookingNo",
]);

const EXACT_TARGETS = Object.freeze(
  [
    {
      key: "agoda_687767359",
      otaBookingId: "687767359",
      otaIdentityKey: "agoda:687767359",
      pmsConfirmationNumber: "9159438168",
      reservationMongoId: "6a77f6d27735a50431e27715",
      reservationVersion: 1,
      reservationDocumentHash:
        "c2f6128fa14081f1e5a342165b6dfd2ee9cfcfbcfd7859ec0af697227be0b586",
      hotelRunnerReservationId: "40371475",
      hrNumber: "R104847019",
      eventId: "6a77f6f5d8cbed2f4bad4723",
      eventDocumentHash:
        "5e59019b320a9f0ebdbf3b3bccdebc717628499252aa18cc163f58b35b093d6b",
      eventPayloadHash:
        "4d25549604db4a470cf374778a06f2ac4d32db43d6349eb16108bba093da00ea",
      canonicalHash:
        "27d108d4add428a6f920b89fcdd00174bd2232105c5b673e7f62a78611827029",
      normalizedSnapshotHash:
        "30e870027327ff220a93435357ed7c6e4c84b7ddf17f5558643d9b9f766294d3",
      mirrorId: "6a77f6f666c058f4ab6177c4",
      mirrorDocumentHash:
        "c10145b91562a4cd5504066bf11855acc9a084adf431a709827a9737dc492cec",
      inboundEmailId: "6a77f6ce7735a50431e2770c",
      inboundAuditDocumentHash:
        "4df108eef7fc554cbc93c228ee4850f3970730d04b0c84a8e03bef9ed7c4c88c",
      inboundBodyTextHash:
        "65bd3705980ff3371e78a5193933c7f325afb8a5d4501db9e5fda65e673b0e1d",
      inboundEmailHash:
        "73975d01e5b78a49b1583981f43a59e79a346e9060a0714c2ffcf87f042264b5",
      evidenceHash:
        "ba380cba16e718ba35fed831d947942f700c80c51f9d63710611771ed95d2c0a",
      evidenceSourceTextHash:
        "9f268d0641a8adbe6d2740fc3a28a3f7ad4e870fa8ebc4f59d1bf5fbe5983a30",
      checkinDate: "2026-08-09",
      checkoutDate: "2026-08-10",
      roomConfigId: "6a40e0981a6d1850eb25c27c",
      sourceRoomNameHash:
        "07c3da07f77f49acf03b4208c8850b3bba40349e9e4e3b590b06949f9597c086",
      rootTotalSar: 75,
      grossTotalSar: 77,
      payoutTotalSar: 47.64,
      otaExpenseTotalSar: 29.36,
      otaCommissionSar: 11.55,
      deductionComponentAmountsSar: [11.55, 7.7, 2.89],
      unclassifiedDeductionSar: 7.22,
      daily: [
        {
          date: "2026-08-09",
          client: 77,
          root: 75,
          payout: 47.64,
          expense: 29.36,
          margin: -27.36,
          hotelRunnerSource: 47.64,
        },
      ],
      paymentDetailsHash:
        "4ef7e06b0773bd26a0b1f5b2a35650685d559e19bdb9785ef622c66efb779b0b",
      paidBreakdownHash:
        "f7c85c17c0cc27448f0cfd75341e150191d9564a6da9103a18cef90107e7a64e",
      financialCycleHash:
        "fe7209179ff616bee52273e6bbbf117d9db32a91590eb302706ecbab05725df1",
    },
    {
      key: "agoda_2039719171",
      otaBookingId: "2039719171",
      otaIdentityKey: "agoda:2039719171",
      pmsConfirmationNumber: "7637630965",
      reservationMongoId: "6a77fd977735a50431e27d88",
      reservationVersion: 1,
      reservationDocumentHash:
        "f9433ed3a273aff6d20560395deb36a1407c6f7b0db9fe9013ffc8e36a941ab8",
      hotelRunnerReservationId: "40371907",
      hrNumber: "R600728446",
      eventId: "6a77fdc8d8cbed2f4bad4724",
      eventDocumentHash:
        "06c75e2d596c55407eef102a13c53fec5b8c98488116f46b97f14b7eca3a635a",
      eventPayloadHash:
        "66af8cd94cdce2975e9271d6e8fcb8fd54461582af64c9eec0738fc9a67c60ec",
      canonicalHash:
        "a28c6b2f6197f04919e3e0a8c3e69201887eb981114a08a215bb5b5a635bff12",
      normalizedSnapshotHash:
        "e31e579972d0819085fc44def706663cae0f371129ac204137f2da227b33c320",
      mirrorId: "6a77fdc966c058f4ab617eaa",
      mirrorDocumentHash:
        "7bcda9ff5aa376945cdbc147374d2fc1756cf848b15b0a1bfb6cb9bbb0dd6436",
      inboundEmailId: "6a77fd947735a50431e27d66",
      inboundAuditDocumentHash:
        "1dc40a6b31d772ba5d5720340f63373d389ec30a69554344c240a5fa65e1f651",
      inboundBodyTextHash:
        "0ecc111a822d04e4fc38682a8e28808cdb34ef3dbc34fc815209f05c73fe0a37",
      inboundEmailHash:
        "2f2e094ea68e4ce21d1d7ea84a0cfaa7f9a4ef274272296b82bfe5fbb37d24f5",
      evidenceHash:
        "f49fb46e9ac0b2d5b3dc34833506e1d32e34ea2bbe7be7244a314d0f0b27acda",
      evidenceSourceTextHash:
        "5905c0f03448a7c59542ab8928bf5240c26c405fa1ffde75302035eb22fe9df9",
      checkinDate: "2026-08-09",
      checkoutDate: "2026-08-11",
      roomConfigId: "6a40e0981a6d1850eb25c27c",
      sourceRoomNameHash:
        "07c3da07f77f49acf03b4208c8850b3bba40349e9e4e3b590b06949f9597c086",
      rootTotalSar: 150,
      grossTotalSar: 148.96,
      payoutTotalSar: 92.18,
      otaExpenseTotalSar: 56.78,
      otaCommissionSar: 22.34,
      deductionComponentAmountsSar: [22.34, 14.9, 5.58],
      unclassifiedDeductionSar: 13.96,
      daily: [
        {
          date: "2026-08-09",
          client: 74.48,
          root: 75,
          payout: 46.09,
          expense: 28.39,
          margin: -28.91,
          hotelRunnerSource: 46.09,
        },
        {
          date: "2026-08-10",
          client: 74.48,
          root: 75,
          payout: 46.09,
          expense: 28.39,
          margin: -28.91,
          hotelRunnerSource: 46.09,
        },
      ],
      paymentDetailsHash:
        "4ef7e06b0773bd26a0b1f5b2a35650685d559e19bdb9785ef622c66efb779b0b",
      paidBreakdownHash:
        "5a84ec57689cf4138452e70c765c91076076e0bd7188c1ba75683a3d6f1bab33",
      financialCycleHash:
        "c5fa770a2a84e2ffdebd5d07f53d5ab990f46ea54ec11b46cb37951708ff8246",
    },
  ].map((target) =>
    Object.freeze({
      ...target,
      deductionComponentAmountsSar: Object.freeze([
        ...target.deductionComponentAmountsSar,
      ]),
      daily: Object.freeze(target.daily.map((day) => Object.freeze(day))),
    })
  )
);

const TARGET_SET_HASH = canonicalEjsonSha256(EXACT_TARGETS);
const MUTATION_CAPABILITIES = new WeakSet();

const clean = (value = "") => String(value?._id || value || "").trim();
const lower = (value = "") => clean(value).toLowerCase();
const upper = (value = "") => clean(value).toUpperCase();
const round2 = (value) => Number(Number(value).toFixed(2));
const sha256 = (value) =>
  crypto
    .createHash("sha256")
    .update(String(value ?? ""), "utf8")
    .digest("hex");
const sameMoney = (left, right) =>
  Number.isFinite(Number(left)) &&
  Number.isFinite(Number(right)) &&
  Math.abs(round2(left) - round2(right)) <= 0.005;
const dateKey = (value) => {
  const parsed = value instanceof Date ? value : new Date(value || "");
  return Number.isFinite(parsed.getTime())
    ? parsed.toISOString().slice(0, 10)
    : "";
};

function fail(message, code = "AGODA_PAID_COMMERCIAL_REPAIR_BLOCKED") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function objectId(value, label = "Mongo id") {
  const normalized = clean(value);
  if (!ObjectId.isValid(normalized)) {
    fail(`${label} is invalid.`, "AGODA_PAID_REPAIR_ID_INVALID");
  }
  return new ObjectId(normalized);
}

function exactDate(value, label) {
  const parsed = value instanceof Date ? new Date(value) : new Date(value || "");
  if (!Number.isFinite(parsed.getTime())) {
    fail(`${label} is missing or invalid.`, "AGODA_PAID_REPAIR_DATE_INVALID");
  }
  return parsed;
}

function parseArguments(argv = []) {
  let apply = false;
  let repairId = "";
  let releaseSha = "";
  let proof = "";
  for (const raw of argv) {
    const argument = clean(raw);
    if (argument === "--apply") {
      if (apply) {
        fail("--apply may be supplied only once.", "AGODA_PAID_ARGUMENT_INVALID");
      }
      apply = true;
      continue;
    }
    let recognized = false;
    for (const [prefix, prior, assign] of [
      ["--repair-id=", repairId, (value) => (repairId = value)],
      ["--release-sha=", releaseSha, (value) => (releaseSha = lower(value))],
      ["--proof=", proof, (value) => (proof = lower(value))],
    ]) {
      if (!argument.startsWith(prefix)) continue;
      if (prior) {
        fail(
          `${prefix.slice(0, -1)} may be supplied only once.`,
          "AGODA_PAID_ARGUMENT_INVALID"
        );
      }
      assign(argument.slice(prefix.length));
      recognized = true;
      break;
    }
    if (!recognized) {
      fail(
        "Unsupported Agoda paid-commercial repair argument.",
        "AGODA_PAID_ARGUMENT_INVALID"
      );
    }
  }
  if (!/^[a-f0-9]{40}$/.test(releaseSha)) {
    fail(
      "An exact 40-character --release-sha is required.",
      "AGODA_PAID_RELEASE_REQUIRED"
    );
  }
  if (!apply && (repairId || proof)) {
    fail(
      "--repair-id and --proof are apply-only.",
      "AGODA_PAID_ARGUMENT_INVALID"
    );
  }
  if (apply && repairId !== REPAIR_ID) {
    fail(
      `Apply requires --repair-id=${REPAIR_ID}.`,
      "AGODA_PAID_REPAIR_ID_REQUIRED"
    );
  }
  if (apply && !/^\d{13}\.[a-f0-9]{64}$/.test(proof)) {
    fail(
      "Apply requires the exact unexpired dry-run proof.",
      "AGODA_PAID_PROOF_REQUIRED"
    );
  }
  return { apply, repairId, releaseSha, proof };
}

function parseProof(proof, now = new Date()) {
  const match = lower(proof).match(/^(\d{13})\.([a-f0-9]{64})$/);
  if (!match) {
    fail("The dry-run proof is invalid.", "AGODA_PAID_PROOF_INVALID");
  }
  const plannedAtMs = Number(match[1]);
  const nowMs = exactDate(now, "proof clock").getTime();
  if (
    !Number.isSafeInteger(plannedAtMs) ||
    plannedAtMs > nowMs + CLOCK_SKEW_MS ||
    nowMs - plannedAtMs > PROOF_MAX_AGE_MS
  ) {
    fail(
      "The dry-run proof is expired or from the future.",
      "AGODA_PAID_PROOF_EXPIRED"
    );
  }
  return {
    plannedAt: new Date(plannedAtMs),
    expiresAt: new Date(plannedAtMs + PROOF_MAX_AGE_MS),
    planHash: match[2],
  };
}

function proofToken(plan) {
  return `${new Date(plan.plannedAt).getTime()}.${plan.planHash}`;
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
          "AGODA_PAID_EXECUTION_INVALID"
        );
      }
      return { path: filePath, blobSha: lower(match[1]) };
    });
    if (
      observedReleaseSha !== lower(releaseSha) ||
      !/^[a-f0-9]{40}$/.test(observedReleaseSha)
    ) {
      fail(
        "The executing checkout is not the exact approved release.",
        "AGODA_PAID_RELEASE_MISMATCH"
      );
    }
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
    if (String(error?.code || "").startsWith("AGODA_PAID_")) throw error;
    fail(
      "The executing checkout could not be attested.",
      "AGODA_PAID_EXECUTION_INVALID"
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
      "AGODA_PAID_EXECUTION_DIRTY"
    );
  }
  return {
    releaseSha: lower(execution.releaseSha),
    treeSha: lower(execution.treeSha),
    executionFingerprint: lower(execution.executionFingerprint),
    trackedWorktreeClean: true,
  };
}

function createMutationCapability({ plan, proofDetails, execution, clock }) {
  if (
    proofDetails.planHash !== plan.planHash ||
    proofToken(plan) !==
      `${proofDetails.plannedAt.getTime()}.${proofDetails.planHash}`
  ) {
    fail(
      "The mutation capability does not match the dry-run plan.",
      "AGODA_PAID_PROOF_MISMATCH"
    );
  }
  const capability = {
    planHash: plan.planHash,
    releaseSha: plan.releaseSha,
    executionFingerprint: execution.executionFingerprint,
    proofIssuedAt: new Date(proofDetails.plannedAt),
    proofExpiresAt: new Date(proofDetails.expiresAt),
    clock,
  };
  MUTATION_CAPABILITIES.add(capability);
  return capability;
}

function assertMutationCapabilityBinding(capability, plan) {
  if (
    !capability ||
    !MUTATION_CAPABILITIES.has(capability) ||
    capability.planHash !== plan.planHash ||
    capability.releaseSha !== plan.releaseSha ||
    capability.executionFingerprint !== plan.execution.executionFingerprint ||
    typeof capability.clock !== "function"
  ) {
    fail(
      "The database mutation boundary is not authorized.",
      "AGODA_PAID_WRITE_UNAUTHORIZED"
    );
  }
  return true;
}

function assertMutationCapability(capability, plan) {
  assertMutationCapabilityBinding(capability, plan);
  const now = exactDate(capability.clock(), "mutation clock");
  if (
    now < capability.proofIssuedAt ||
    now > capability.proofExpiresAt
  ) {
    fail(
      "The dry-run proof expired before the database mutation.",
      "AGODA_PAID_PROOF_EXPIRED"
    );
  }
  return now;
}

const primaryReadOptions = (session = null) =>
  session
    ? { session }
    : { readPreference: "primary", readConcern: { level: "majority" } };
const majorityWriteOptions = (session = null) =>
  session ? { session } : { writeConcern: { w: "majority" } };

async function findMany(collection, filter, limit = 3, session = null) {
  return collection
    .find(filter, primaryReadOptions(session))
    .limit(limit)
    .toArray();
}

function reservationIdentityLookup(target) {
  return {
    $or: [
      { _id: objectId(target.reservationMongoId) },
      { confirmation_number: target.pmsConfirmationNumber },
      { reservation_id: target.otaBookingId },
      { otaIdentityKey: target.otaIdentityKey },
      { otaCrossTransportIdentityKey: target.otaIdentityKey },
      { "customer_details.confirmation_number2": target.otaBookingId },
      { "supplierData.suppliedBookingNo": target.otaBookingId },
      { "supplierData.otaConfirmationNumber": target.otaBookingId },
      { "supplierData.platformConfirmationNumber": target.otaBookingId },
      {
        "supplierData.hotelRunner.reservationId":
          target.hotelRunnerReservationId,
      },
      { "supplierData.hotelRunner.hrNumber": target.hrNumber },
    ],
  };
}

function eventIdentityLookup(target) {
  return {
    $or: [
      { _id: objectId(target.eventId) },
      { hotelRunnerReservationId: target.hotelRunnerReservationId },
      { hrNumber: target.hrNumber },
      { providerNumber: target.otaBookingId },
      { reservationMongoId: objectId(target.reservationMongoId) },
    ],
  };
}

function mirrorIdentityLookup(target) {
  return {
    $or: [
      { _id: objectId(target.mirrorId) },
      { hotelRunnerReservationId: target.hotelRunnerReservationId },
      { hrNumber: target.hrNumber },
      { providerNumber: target.otaBookingId },
      { reservationMongoId: objectId(target.reservationMongoId) },
    ],
  };
}

function directAuditIdentityLookup(target) {
  return {
    provider: "agoda",
    "senderAuthentication.authenticatedAligned": true,
    "senderAuthentication.trustedProvider": "agoda",
    $or: [
      { _id: objectId(target.inboundEmailId) },
      { confirmationNumber: target.otaBookingId },
    ],
  };
}

async function exactOne(collection, filter, label, session = null) {
  const documents = await findMany(collection, filter, 3, session);
  if (!Array.isArray(documents) || documents.length !== 1) {
    fail(
      `${label} requires exactly one document; found ${documents?.length || 0}.`,
      "AGODA_PAID_EXACT_ONE_FAILED"
    );
  }
  return documents[0];
}

function normalizeHotelName(value) {
  return lower(value).replace(/[^a-z0-9]+/g, "");
}

function assertHotel(hotel, targets = EXACT_TARGETS) {
  if (
    clean(hotel?._id) !== EXPECTED_HOTEL_ID ||
    normalizeHotelName(hotel?.hotelName) !== EXPECTED_HOTEL_NAME_KEY ||
    hotel?.activateHotel !== true ||
    hotel?.xHotelProActive === false
  ) {
    fail("The exact active hotel boundary changed.", "AGODA_PAID_HOTEL_INVALID");
  }
  for (const target of targets) {
    const roomMatches = (Array.isArray(hotel?.roomCountDetails)
      ? hotel.roomCountDetails
      : []
    ).filter((room) => clean(room?._id) === target.roomConfigId);
    if (roomMatches.length !== 1 || roomMatches[0]?.activeRoom === false) {
      fail(
        `${target.key} exact hotel room configuration changed.`,
        "AGODA_PAID_HOTEL_ROOM_INVALID"
      );
    }
  }
}

function roomIdentityRows(rooms = []) {
  return (Array.isArray(rooms) ? rooms : []).map((room) => ({
    roomType: room?.room_type,
    displayName: room?.displayName,
    sourceRoomNameHash: sha256(room?.sourceRoomName || ""),
    hotelRoomConfigId: clean(room?.hotelRoomConfigId),
    localRoomConfigId: clean(room?.localRoomConfigId),
    count: Number(room?.count || 1),
    hotelShouldGet: round2(room?.hotelShouldGet),
    pricingByDay: (Array.isArray(room?.pricingByDay)
      ? room.pricingByDay
      : []
    ).map((day) => ({
      date: dateKey(day?.date),
      rootPrice: round2(day?.rootPrice),
      totalPriceWithoutCommission: day?.totalPriceWithoutCommission,
    })),
  }));
}

function paymentSettlementSnapshot(reservation = {}) {
  return cloneBson({
    financeStatus: reservation.financeStatus,
    payment: reservation.payment,
    paid_amount: reservation.paid_amount,
    payment_details: reservation.payment_details,
    paid_amount_breakdown: reservation.paid_amount_breakdown,
    financial_cycle: reservation.financial_cycle,
    vcc_payment: reservation.vcc_payment,
    bofa_payment: reservation.bofa_payment,
    braintree_payment: reservation.braintree_payment,
    paypal_details: reservation.paypal_details,
    moneyTransferredToHotel: reservation.moneyTransferredToHotel,
    moneyTransferredAt: reservation.moneyTransferredAt,
    commissionPaid: reservation.commissionPaid,
    commissionStatus: reservation.commissionStatus,
    commissionData: reservation.commissionData,
    commissionPaidAt: reservation.commissionPaidAt,
    commissionAgentApproval: reservation.commissionAgentApproval,
    adminLastUpdatedAt: reservation.adminLastUpdatedAt,
    adminLastUpdatedBy: reservation.adminLastUpdatedBy,
    adminChangeLog: reservation.adminChangeLog,
  });
}

function guestLifecycleSnapshot(reservation = {}) {
  return cloneBson({
    customer_details: reservation.customer_details,
    state: reservation.state,
    reservation_status: reservation.reservation_status,
    checkin_date: reservation.checkin_date,
    checkout_date: reservation.checkout_date,
    total_rooms: reservation.total_rooms,
    total_guests: reservation.total_guests,
    adults: reservation.adults,
    children: reservation.children,
    roomId: reservation.roomId,
    bedNumber: reservation.bedNumber,
    housedBy: reservation.housedBy,
    pendingConfirmation: reservation.pendingConfirmation,
    otaPlatformReview: reservation.otaPlatformReview,
    availabilitySnapshot: reservation.availabilitySnapshot,
    agentDecisionSnapshot: reservation.agentDecisionSnapshot,
  });
}

function rootBaseSnapshot(reservation = {}) {
  return cloneBson({
    sub_total: reservation.sub_total,
    adminRootTotal: reservation.adminPricing?.rootTotal,
    hotelVisibleAmount: reservation.ota_financial_summary?.hotelVisibleAmount,
    pickedRoomsType: roomIdentityRows(reservation.pickedRoomsType),
    pickedRoomsPricing: roomIdentityRows(reservation.pickedRoomsPricing),
  });
}

const ALLOWED_ADMIN_PRICING_KEYS = new Set([
  "clientTotal",
  "netAfterExpensesTotal",
  "otaExpenseTotal",
  "platformMarginTotal",
  "commissionAmount",
  "defaultDeductionApplied",
  "payoutFallbackReason",
  "commercialVerified",
]);
const ALLOWED_SUMMARY_KEYS = new Set([
  "show",
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
  "paymentSummary",
  "payoutFallbackReason",
]);
const ALLOWED_SUPPLIER_KEYS = new Set([
  "otaPaymentSummary",
  "otaTotalPayoutSar",
  "otaExpenseTotalSar",
  "otaCommissionSar",
  "otaCommissionSource",
  "otaCommissionSourceBacked",
  "otaPlatformMarginSar",
  "otaPayoutFallbackReason",
  "hotelRunnerEmailCommercialEvidence",
  "otaCommercialEvidence",
]);
const ALLOWED_ROOM_KEYS = new Set([
  "chosenPrice",
  "totalPriceWithCommission",
]);
const ALLOWED_DAY_KEYS = new Set([
  "price",
  "clientPrice",
  "mainPrice",
  "totalPriceWithCommission",
  "netAfterExpenses",
  "netAfterOtaExpenses",
  "otaExpenseAmount",
  "platformMargin",
  "commercialVerification",
  "hotelRunnerSourcePrice",
]);

function removeKeys(object, keys) {
  if (!object || typeof object !== "object" || Array.isArray(object)) return;
  for (const key of keys) delete object[key];
}

function removeAllowedRoomCommercial(rooms = []) {
  for (const room of Array.isArray(rooms) ? rooms : []) {
    removeKeys(room, ALLOWED_ROOM_KEYS);
    for (const day of Array.isArray(room?.pricingByDay)
      ? room.pricingByDay
      : []) {
      removeKeys(day, ALLOWED_DAY_KEYS);
    }
  }
}

function immutableRemainder(reservation = {}) {
  const copy = cloneBson(reservation);
  delete copy.__v;
  delete copy.total_amount;
  delete copy.commission_ota;
  delete copy.reservationAuditLog;
  removeAllowedRoomCommercial(copy.pickedRoomsType);
  removeAllowedRoomCommercial(copy.pickedRoomsPricing);
  removeKeys(copy.adminPricing, ALLOWED_ADMIN_PRICING_KEYS);
  removeKeys(copy.ota_financial_summary, ALLOWED_SUMMARY_KEYS);
  removeKeys(copy.supplierData, ALLOWED_SUPPLIER_KEYS);
  return copy;
}

function assertReservationBoundary(target, reservation) {
  const pricingRooms = roomIdentityRows(reservation?.pickedRoomsPricing);
  const typeRooms = roomIdentityRows(reservation?.pickedRoomsType);
  const matches = detectConfirmationMatchFields(
    reservation,
    target.otaBookingId,
    "agoda"
  ).sort();
  if (
    clean(reservation?._id) !== target.reservationMongoId ||
    clean(reservation?.hotelId) !== EXPECTED_HOTEL_ID ||
    clean(reservation?.confirmation_number) !== target.pmsConfirmationNumber ||
    clean(reservation?.reservation_id) !== target.otaBookingId ||
    upper(reservation?.hr_number) !== target.hrNumber ||
    lower(reservation?.otaIdentityKey) !== target.otaIdentityKey ||
    clean(reservation?.otaCrossTransportIdentityKey) ||
    dateKey(reservation?.checkin_date) !== target.checkinDate ||
    dateKey(reservation?.checkout_date) !== target.checkoutDate ||
    Number(reservation?.total_rooms) !== 1 ||
    upper(reservation?.currency) !== "SAR" ||
    !sameMoney(reservation?.sub_total, target.rootTotalSar) ||
    !sameMoney(reservation?.adminPricing?.rootTotal, target.rootTotalSar) ||
    !sameMoney(
      reservation?.ota_financial_summary?.hotelVisibleAmount,
      target.rootTotalSar
    ) ||
    !sameMoney(reservation?.commission, 0) ||
    clean(reservation?.supplierData?.hotelRunner?.reservationId) !==
      target.hotelRunnerReservationId ||
    upper(reservation?.supplierData?.hotelRunner?.hrNumber) !== target.hrNumber ||
    clean(reservation?.supplierData?.hotelRunner?.providerNumber) !==
      target.otaBookingId ||
    pricingRooms.length !== 1 ||
    pricingRooms[0].hotelRoomConfigId !== target.roomConfigId ||
    pricingRooms[0].localRoomConfigId !== target.roomConfigId ||
    pricingRooms[0].sourceRoomNameHash !== target.sourceRoomNameHash ||
    canonicalEjsonSha256(pricingRooms) !== canonicalEjsonSha256(typeRooms) ||
    canonicalEjsonSha256(matches) !==
      canonicalEjsonSha256([...REQUIRED_MATCH_FIELDS].sort())
  ) {
    fail(
      `${target.key} identity, hotel, stay, room, or protected root boundary changed.`,
      "AGODA_PAID_RESERVATION_BOUNDARY_INVALID"
    );
  }
  if (
    lower(reservation?.financeStatus) !== "paid online" ||
    lower(reservation?.payment) !== "paid online" ||
    !sameMoney(reservation?.paid_amount, target.grossTotalSar) ||
    reservation?.payment_details?.captured !== false ||
    !sameMoney(reservation?.payment_details?.onsite_paid_amount, 0) ||
    !sameMoney(
      reservation?.paid_amount_breakdown?.paid_online_other_platforms,
      target.grossTotalSar
    ) ||
    lower(reservation?.financial_cycle?.collectionModel) !== "pms_collected" ||
    lower(reservation?.financial_cycle?.status) !== "open" ||
    !sameMoney(
      reservation?.financial_cycle?.pmsCollectedAmount,
      target.grossTotalSar
    ) ||
    !sameMoney(
      reservation?.financial_cycle?.hotelPayoutDue,
      target.rootTotalSar
    )
  ) {
    fail(
      `${target.key} exact protected paid state changed.`,
      "AGODA_PAID_PAYMENT_BOUNDARY_INVALID"
    );
  }
  if (
    canonicalEjsonSha256(reservation?.payment_details) !==
      target.paymentDetailsHash ||
    canonicalEjsonSha256(reservation?.paid_amount_breakdown) !==
      target.paidBreakdownHash ||
    canonicalEjsonSha256(reservation?.financial_cycle) !==
      target.financialCycleHash
  ) {
    fail(
      `${target.key} audited payment object hash changed.`,
      "AGODA_PAID_PAYMENT_HASH_MISMATCH"
    );
  }
}

function assertEnvelope(target, event, mirror, audit) {
  if (
    clean(event?._id) !== target.eventId ||
    clean(event?.hotelId) !== EXPECTED_HOTEL_ID ||
    clean(event?.hotelRunnerReservationId) !==
      target.hotelRunnerReservationId ||
    upper(event?.hrNumber) !== target.hrNumber ||
    clean(event?.providerNumber) !== target.otaBookingId ||
    lower(event?.source) !== "push" ||
    lower(event?.status) !== "attention" ||
    Number(event?.attempts) !== 1 ||
    event?.integrityConflict === true ||
    clean(event?.integrityReason) ||
    clean(event?.errorCode) !== "hotelrunner_commercial_evidence_stale" ||
    clean(event?.payloadHash) !== target.eventPayloadHash ||
    clean(event?.canonicalHash) !== target.canonicalHash ||
    clean(event?.reservationMongoId) !== target.reservationMongoId ||
    clean(event?.mirrorId) !== target.mirrorId ||
    canonicalEjsonSha256(event) !== target.eventDocumentHash ||
    canonicalEjsonSha256(event?.payload) !== target.normalizedSnapshotHash
  ) {
    fail(
      `${target.key} exact HotelRunner event proof changed.`,
      "AGODA_PAID_EVENT_INVALID"
    );
  }
  if (
    clean(mirror?._id) !== target.mirrorId ||
    clean(mirror?.hotelId) !== EXPECTED_HOTEL_ID ||
    clean(mirror?.hotelRunnerReservationId) !==
      target.hotelRunnerReservationId ||
    upper(mirror?.hrNumber) !== target.hrNumber ||
    clean(mirror?.providerNumber) !== target.otaBookingId ||
    clean(mirror?.observedCanonicalHash) !== target.canonicalHash ||
    clean(mirror?.appliedCanonicalHash) !== target.canonicalHash ||
    Number(mirror?.projectionVersion) !== 1 ||
    lower(mirror?.projectionStatus) !== "updated" ||
    mirror?.identityConflict === true ||
    clean(mirror?.reservationMongoId) !== target.reservationMongoId ||
    canonicalEjsonSha256(mirror) !== target.mirrorDocumentHash ||
    canonicalEjsonSha256(mirror?.normalizedSnapshot) !==
      target.normalizedSnapshotHash ||
    canonicalEjsonSha256(mirror?.normalizedSnapshot) !==
      canonicalEjsonSha256(event?.payload)
  ) {
    fail(
      `${target.key} exact HotelRunner mirror proof changed.`,
      "AGODA_PAID_MIRROR_INVALID"
    );
  }
  if (
    clean(audit?._id) !== target.inboundEmailId ||
    lower(audit?.provider) !== "agoda" ||
    clean(audit?.confirmationNumber) !== target.otaBookingId ||
    audit?.senderAuthentication?.authenticatedAligned !== true ||
    lower(audit?.senderAuthentication?.trustedProvider) !== "agoda" ||
    audit?.duplicateOf != null ||
    clean(audit?.emailHash) !== target.inboundEmailHash ||
    clean(audit?.textHash) !== target.inboundBodyTextHash ||
    sha256(audit?.bodyText) !== target.inboundBodyTextHash ||
    canonicalEjsonSha256(audit) !== target.inboundAuditDocumentHash
  ) {
    fail(
      `${target.key} exact authenticated Agoda audit proof changed.`,
      "AGODA_PAID_AUDIT_INVALID"
    );
  }
}

function mirrorDailyPayout(target, mirror) {
  const snapshot = mirror?.normalizedSnapshot || {};
  const rooms = Array.isArray(snapshot.rooms) ? snapshot.rooms : [];
  const expectedCents = Math.round(target.payoutTotalSar * 100);
  if (
    upper(snapshot.currency) !== "SAR" ||
    Number(snapshot.totalCents) !== expectedCents ||
    Number(snapshot.subTotalCents) !== expectedCents ||
    Number(snapshot.itemTotalCents) !== expectedCents ||
    Number(snapshot.taxTotalCents) !== 0 ||
    Number(snapshot.totalRooms) !== 1 ||
    dateKey(snapshot.checkinDate) !== target.checkinDate ||
    dateKey(snapshot.checkoutDate) !== target.checkoutDate ||
    rooms.length !== 1
  ) {
    fail(
      `${target.key} HotelRunner mirror no longer proves the exact SAR payout.`,
      "AGODA_PAID_MIRROR_COMMERCIAL_INVALID"
    );
  }
  const rows = Array.isArray(rooms[0]?.dailyPrices)
    ? rooms[0].dailyPrices.map((day) => ({
        date: dateKey(day?.date),
        amount: Number.isSafeInteger(day?.priceCents)
          ? round2(day.priceCents / 100)
          : NaN,
      }))
    : [];
  const expected = target.daily.map((day) => ({
    date: day.date,
    amount: day.hotelRunnerSource,
  }));
  if (
    canonicalEjsonSha256(rows) !== canonicalEjsonSha256(expected) ||
    !sameMoney(
      rows.reduce((sum, row) => sum + Number(row.amount || 0), 0),
      target.payoutTotalSar
    )
  ) {
    fail(
      `${target.key} HotelRunner mirror nightly payout changed.`,
      "AGODA_PAID_MIRROR_NIGHTLY_INVALID"
    );
  }
  return rows;
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
      audit?.normalizedReservation?.source?.timestampMethod ||
      "stored_inbound_audit",
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

function assertAuthenticatedEvidence(target, normalized, evidence) {
  const summary = normalized?.paymentSummary || {};
  const componentAmounts = (Array.isArray(evidence?.deductionComponents)
    ? evidence.deductionComponents
    : []
  ).map((component) => round2(component?.amountSar));
  if (
    normalized?.provider !== "agoda" ||
    normalized?.sourceSenderTrusted !== true ||
    normalized?.sourceSenderAuthenticated !== true ||
    normalized?.requiresManualReview === true ||
    clean(normalized?.confirmationNumber) !== target.otaBookingId ||
    dateKey(normalized?.checkinDate) !== target.checkinDate ||
    dateKey(normalized?.checkoutDate) !== target.checkoutDate ||
    Number(normalized?.roomCount) !== 1 ||
    !sameMoney(normalized?.totalAmountSar, target.grossTotalSar) ||
    !sameMoney(normalized?.totalPayoutSar, target.payoutTotalSar) ||
    !sameMoney(normalized?.otaCommissionSar, target.otaCommissionSar) ||
    upper(summary.sourceCurrency) !== "SAR" ||
    upper(summary.sourceTotalPayoutCurrency) !== "SAR" ||
    upper(summary.currency) !== "SAR" ||
    !sameMoney(summary.sourceTotalGuestPaymentAmount, target.grossTotalSar) ||
    !sameMoney(summary.sourceTotalPayoutAmount, target.payoutTotalSar) ||
    !sameMoney(summary.totalGuestPaymentAmount, target.grossTotalSar) ||
    !sameMoney(summary.totalPayoutAmount, target.payoutTotalSar) ||
    !sameMoney(summary.exchangeRateToSar, 1) ||
    lower(summary.exchangeRateSource) !== "identity"
  ) {
    fail(
      `${target.key} authenticated Agoda source or SAR identity conversion changed.`,
      "AGODA_PAID_SOURCE_EVIDENCE_INVALID"
    );
  }
  if (
    !evidence ||
    Number(evidence.version) !== 2 ||
    evidence.verified !== true ||
    evidence.source !== "authenticated_ota_email" ||
    evidence.provider !== "agoda" ||
    evidence.otaIdentityKey !== target.otaIdentityKey ||
    upper(evidence.currency) !== "SAR" ||
    evidence.inboundEmailId !== target.inboundEmailId ||
    evidence.evidenceHash !== target.evidenceHash ||
    evidence.sourceTextHash !== target.evidenceSourceTextHash ||
    !sameMoney(evidence.grossTotalSar, target.grossTotalSar) ||
    !sameMoney(evidence.payoutTotalSar, target.payoutTotalSar) ||
    !sameMoney(evidence.otaExpenseTotalSar, target.otaExpenseTotalSar) ||
    !sameMoney(evidence.otaCommissionSar, target.otaCommissionSar) ||
    !sameMoney(
      evidence.unclassifiedDeductionSar,
      target.unclassifiedDeductionSar
    ) ||
    canonicalEjsonSha256(componentAmounts) !==
      canonicalEjsonSha256(target.deductionComponentAmountsSar) ||
    canonicalEjsonSha256(evidence.unpricedDeductionLabels || []) !==
      canonicalEjsonSha256(["Targeted promotions"])
  ) {
    fail(
      `${target.key} exact shared commercial evidence changed.`,
      "AGODA_PAID_COMMERCIAL_EVIDENCE_INVALID"
    );
  }
}

function applyDottedSet(document, set = {}) {
  const next = cloneBson(document);
  for (const [pathText, value] of Object.entries(set)) {
    const parts = pathText.split(".");
    let current = next;
    for (const part of parts.slice(0, -1)) {
      if (
        !current[part] ||
        typeof current[part] !== "object" ||
        Array.isArray(current[part])
      ) {
        current[part] = {};
      }
      current = current[part];
    }
    current[parts.at(-1)] = cloneBson(value);
  }
  return next;
}

function seedMirrorSourcePrices(target, reservation, mirrorRows) {
  const next = cloneBson(reservation);
  const sourceByDate = new Map(
    mirrorRows.map((row) => [row.date, round2(row.amount)])
  );
  for (const field of ["pickedRoomsType", "pickedRoomsPricing"]) {
    const rooms = Array.isArray(next[field]) ? next[field] : [];
    const days = rooms.flatMap((room) =>
      Array.isArray(room?.pricingByDay) ? room.pricingByDay : []
    );
    if (
      rooms.length !== 1 ||
      days.length !== target.daily.length ||
      days.some((day) => !sourceByDate.has(dateKey(day?.date)))
    ) {
      fail(
        `${target.key} cannot align mirror payout nights to PMS pricing slots.`,
        "AGODA_PAID_SOURCE_PRICE_ALIGNMENT_FAILED"
      );
    }
    for (const day of days) {
      day.hotelRunnerSourcePrice = sourceByDate.get(dateKey(day.date));
    }
  }
  return next;
}

function commercialRows(reservation = {}) {
  return (Array.isArray(reservation?.pickedRoomsPricing)
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
      hotelRunnerSource:
        day?.hotelRunnerSourcePrice == null
          ? null
          : round2(day.hotelRunnerSourcePrice),
    }))
  );
}

function repairAuditEntry(target, evidence, releaseSha, plannedAt) {
  return {
    at: new Date(plannedAt),
    source: "authenticated-agoda-email-incident-repair",
    action: "paid-commercial-materialized-from-verified-email",
    provider: "agoda",
    reservationId: target.otaBookingId,
    repairId: REPAIR_ID,
    releaseSha: lower(releaseSha),
    inboundEmailId: target.inboundEmailId,
    hotelRunnerEventId: target.eventId,
    hotelRunnerMirrorId: target.mirrorId,
    evidenceHash: evidence.evidenceHash,
    vendorApiCalls: 0,
  };
}

function assertMaterialized(target, before, after, evidence, releaseSha) {
  const marker = verifiedHotelRunnerEmailCommercialEvidence(after, {
    provider: "agoda",
    grossTotalSar: target.grossTotalSar,
    currency: "SAR",
  });
  const rows = commercialRows(after);
  const auditBefore = Array.isArray(before?.reservationAuditLog)
    ? before.reservationAuditLog
    : [];
  const auditAfter = Array.isArray(after?.reservationAuditLog)
    ? after.reservationAuditLog
    : [];
  const lastAudit = auditAfter.at(-1);
  if (
    !marker ||
    marker.evidenceHash !== target.evidenceHash ||
    !sameMoney(after?.total_amount, target.grossTotalSar) ||
    !sameMoney(after?.commission, 0) ||
    !sameMoney(after?.commission_ota, target.otaCommissionSar) ||
    !sameMoney(after?.adminPricing?.clientTotal, target.grossTotalSar) ||
    !sameMoney(
      after?.adminPricing?.netAfterExpensesTotal,
      target.payoutTotalSar
    ) ||
    !sameMoney(
      after?.adminPricing?.otaExpenseTotal,
      target.otaExpenseTotalSar
    ) ||
    after?.adminPricing?.commercialVerified !== true ||
    after?.ota_financial_summary?.commercialVerified !== true ||
    !sameMoney(
      after?.ota_financial_summary?.unclassifiedOtaDeduction,
      target.unclassifiedDeductionSar
    ) ||
    canonicalEjsonSha256(
      (after?.ota_financial_summary?.otaDeductionBreakdown || []).map(
        (component) => round2(component?.amountSar)
      )
    ) !== canonicalEjsonSha256(target.deductionComponentAmountsSar) ||
    canonicalEjsonSha256(rows) !== canonicalEjsonSha256(target.daily) ||
    canonicalEjsonSha256(after?.pickedRoomsType || []) !==
      canonicalEjsonSha256(after?.pickedRoomsPricing || []) ||
    Number(after?.__v) !== Number(before?.__v) + 1 ||
    auditAfter.length !== auditBefore.length + 1 ||
    canonicalEjsonSha256(auditAfter.slice(0, -1)) !==
      canonicalEjsonSha256(auditBefore) ||
    clean(lastAudit?.repairId) !== REPAIR_ID ||
    lower(lastAudit?.releaseSha) !== lower(releaseSha) ||
    clean(lastAudit?.evidenceHash) !== evidence.evidenceHash
  ) {
    fail(
      `${target.key} expected commercial materialization is not exact.`,
      "AGODA_PAID_EXPECTED_DOCUMENT_INVALID"
    );
  }
  for (const [label, snapshot] of [
    ["payment/VCC/settlement", paymentSettlementSnapshot],
    ["guest/lifecycle", guestLifecycleSnapshot],
    ["root/base", rootBaseSnapshot],
    ["immutable remainder", immutableRemainder],
  ]) {
    if (
      canonicalEjsonSha256(snapshot(before)) !==
      canonicalEjsonSha256(snapshot(after))
    ) {
      fail(
        `${target.key} ${label} changed in the planned repair.`,
        "AGODA_PAID_PROTECTED_STATE_CHANGED"
      );
    }
  }
  return true;
}

function buildExpectedMaterialization({
  target,
  reservation,
  mirror,
  normalized,
  evidence,
  plannedAt,
  releaseSha,
}) {
  const mirrorRows = mirrorDailyPayout(target, mirror);
  const seeded = seedMirrorSourcePrices(target, reservation, mirrorRows);
  const commercialPricing = buildDirectHotelRunnerCommercialPricing(
    seeded,
    normalized,
    evidence,
    { reportedTotalRole: "payout" }
  );
  if (!commercialPricing) {
    fail(
      `${target.key} shared pricing mapper rejected mirror-seeded evidence.`,
      "AGODA_PAID_PRICING_INVALID"
    );
  }
  const set = directHotelRunnerCommercialEnrichmentSet(normalized, evidence, {
    reportedTotalRole: "payout",
    existing: seeded,
    commercialPricing,
  });
  if (!set) {
    fail(
      `${target.key} shared enrichment mapper returned no commercial set.`,
      "AGODA_PAID_ENRICHMENT_INVALID"
    );
  }
  // The shared mapper normalizes the property currency marker to `SAR`. The
  // audited documents already represent SAR (their schema-stored value may be
  // lowercase), so this incident repair preserves that existing BSON field
  // byte-for-byte while still materializing explicit SAR identity evidence in
  // both commercial payment summaries.
  if (
    Object.prototype.hasOwnProperty.call(set, "currency") &&
    upper(set.currency) !== "SAR"
  ) {
    fail(
      `${target.key} shared enrichment proposed a non-SAR property currency.`,
      "AGODA_PAID_CURRENCY_INVALID"
    );
  }
  delete set.currency;
  let expectedDocument = applyDottedSet(reservation, set);
  expectedDocument.__v = Number(reservation.__v) + 1;
  expectedDocument.reservationAuditLog = [
    ...(Array.isArray(reservation.reservationAuditLog)
      ? cloneBson(reservation.reservationAuditLog)
      : []),
    repairAuditEntry(target, evidence, releaseSha, plannedAt),
  ];
  assertMaterialized(
    target,
    reservation,
    expectedDocument,
    evidence,
    releaseSha
  );
  return { set, expectedDocument, commercialPricing, mirrorRows };
}

async function loadRawScope(db, target, session = null) {
  const reservation = await exactOne(
    db.collection(COLLECTIONS.reservation),
    reservationIdentityLookup(target),
    `${target.key} reservation identity`,
    session
  );
  const event = await exactOne(
    db.collection(COLLECTIONS.event),
    eventIdentityLookup(target),
    `${target.key} HotelRunner event identity`,
    session
  );
  const mirror = await exactOne(
    db.collection(COLLECTIONS.mirror),
    mirrorIdentityLookup(target),
    `${target.key} HotelRunner mirror identity`,
    session
  );
  const audit = await exactOne(
    db.collection(COLLECTIONS.audit),
    directAuditIdentityLookup(target),
    `${target.key} authenticated Agoda audit identity`,
    session
  );
  assertReservationBoundary(target, reservation);
  assertEnvelope(target, event, mirror, audit);
  return { target, reservation, event, mirror, audit };
}

function buildReadyScope(rawScope, { plannedAt, releaseSha, hotel }) {
  const { target, reservation, event, mirror, audit } = rawScope;
  const originalHash = canonicalEjsonSha256(reservation);
  if (
    originalHash !== target.reservationDocumentHash ||
    Number(reservation.__v) !== target.reservationVersion ||
    reservation?.supplierData?.hotelRunnerEmailCommercialEvidence != null
  ) {
    fail(
      `${target.key} no longer equals the exact audited pre-repair document.`,
      "AGODA_PAID_PRESTATE_HASH_MISMATCH"
    );
  }
  const normalized = normalizedFromAudit(target, audit);
  const evidence = buildHotelRunnerEmailCommercialEvidence(normalized, {
    appliedAt: new Date(plannedAt),
  });
  assertAuthenticatedEvidence(target, normalized, evidence);
  const guard = directHotelRunnerEmailCommercialGuard({
    normalized,
    existing: reservation,
    hotelDetails: hotel,
    matchedReservationBy: [...REQUIRED_MATCH_FIELDS],
    evidence,
  });
  if (guard?.ok !== false || guard?.reason !== "protected_state") {
    fail(
      `${target.key} shared guard no longer stops at the audited protected state (${clean(
        guard?.reason || "unexpected_ok"
      )}).`,
      "AGODA_PAID_GUARD_CHANGED"
    );
  }
  const built = buildExpectedMaterialization({
    target,
    reservation,
    mirror,
    normalized,
    evidence,
    plannedAt,
    releaseSha,
  });
  return {
    ...rawScope,
    normalized,
    evidence,
    set: built.set,
    mirrorRows: built.mirrorRows,
    originalDocument: cloneBson(reservation),
    originalHash,
    expectedDocument: built.expectedDocument,
    expectedHash: canonicalEjsonSha256(built.expectedDocument),
    immutableRemainderHash: canonicalEjsonSha256(
      immutableRemainder(reservation)
    ),
    paymentSettlementHash: canonicalEjsonSha256(
      paymentSettlementSnapshot(reservation)
    ),
    guestLifecycleHash: canonicalEjsonSha256(
      guestLifecycleSnapshot(reservation)
    ),
    rootBaseHash: canonicalEjsonSha256(rootBaseSnapshot(reservation)),
  };
}

function planScopeEntry(scope) {
  return {
    key: scope.target.key,
    otaBookingId: scope.target.otaBookingId,
    reservationMongoId: scope.target.reservationMongoId,
    originalHash: scope.originalHash,
    expectedHash: scope.expectedHash,
    evidenceHash: scope.evidence.evidenceHash,
    eventId: scope.target.eventId,
    eventHash: scope.target.eventDocumentHash,
    mirrorId: scope.target.mirrorId,
    mirrorHash: scope.target.mirrorDocumentHash,
    auditId: scope.target.inboundEmailId,
    auditHash: scope.target.inboundAuditDocumentHash,
    normalizedSnapshotHash: scope.target.normalizedSnapshotHash,
    immutableRemainderHash: scope.immutableRemainderHash,
    paymentSettlementHash: scope.paymentSettlementHash,
    guestLifecycleHash: scope.guestLifecycleHash,
    rootBaseHash: scope.rootBaseHash,
  };
}

function backupRole(target, kind) {
  return `${target.key}:${kind}`;
}

function backupRecord({
  target,
  kind,
  collection,
  document,
  capturedAt,
  expectedRepairedHash = "",
}) {
  const originalDocument = cloneBson(document);
  const originalEjson = canonicalEjson(originalDocument);
  const base = {
    _id: `${REPAIR_ID}:${backupRole(target, kind)}`,
    repairId: REPAIR_ID,
    targetKey: target.key,
    role: backupRole(target, kind),
    sourceCollection: collection,
    documentId: clean(document?._id),
    capturedAt: new Date(capturedAt),
    originalHash: canonicalEjsonSha256(originalDocument),
    originalEjsonSha256: sha256(originalEjson),
    originalEjson,
    originalDocument,
    expectedRepairedHash,
  };
  return { ...base, recordHash: canonicalEjsonSha256(base) };
}

function buildBackupRecords(plan) {
  if (plan.state !== "ready") {
    fail("Only a ready plan can build the permanent pre-repair backup.");
  }
  return plan.scopes.flatMap((scope) => [
    backupRecord({
      target: scope.target,
      kind: "reservation_before",
      collection: COLLECTIONS.reservation,
      document: scope.originalDocument,
      expectedRepairedHash: scope.expectedHash,
      capturedAt: plan.plannedAt,
    }),
    backupRecord({
      target: scope.target,
      kind: "hotelrunner_event_evidence",
      collection: COLLECTIONS.event,
      document: scope.event,
      capturedAt: plan.plannedAt,
    }),
    backupRecord({
      target: scope.target,
      kind: "hotelrunner_mirror_evidence",
      collection: COLLECTIONS.mirror,
      document: scope.mirror,
      capturedAt: plan.plannedAt,
    }),
    backupRecord({
      target: scope.target,
      kind: "authenticated_agoda_audit_evidence",
      collection: COLLECTIONS.audit,
      document: scope.audit,
      capturedAt: plan.plannedAt,
    }),
  ]);
}

function verifyBackupRecords(records, manifest = null, targets = EXACT_TARGETS) {
  const expectedRoles = targets.flatMap((target) => [
    backupRole(target, "reservation_before"),
    backupRole(target, "hotelrunner_event_evidence"),
    backupRole(target, "hotelrunner_mirror_evidence"),
    backupRole(target, "authenticated_agoda_audit_evidence"),
  ]);
  if (!Array.isArray(records) || records.length !== expectedRoles.length) {
    fail(
      `The permanent backup must contain exactly ${expectedRoles.length} full documents.`,
      "AGODA_PAID_BACKUP_INCOMPLETE"
    );
  }
  const byRole = new Map();
  for (const record of records) {
    const base = { ...record };
    delete base.recordHash;
    if (
      clean(record?.repairId) !== REPAIR_ID ||
      !expectedRoles.includes(record?.role) ||
      byRole.has(record?.role) ||
      canonicalEjsonSha256(base) !== record?.recordHash ||
      canonicalEjsonSha256(record?.originalDocument) !==
        record?.originalHash ||
      canonicalEjson(record?.originalDocument) !== record?.originalEjson ||
      sha256(record?.originalEjson) !== record?.originalEjsonSha256
    ) {
      fail(
        `Permanent backup integrity failed for ${clean(record?.role)}.`,
        "AGODA_PAID_BACKUP_INVALID"
      );
    }
    byRole.set(record.role, record);
  }
  for (const role of expectedRoles) {
    if (!byRole.has(role)) {
      fail(
        `Permanent backup role ${role} is missing.`,
        "AGODA_PAID_BACKUP_INCOMPLETE"
      );
    }
  }
  const backupSetSha256 = canonicalEjsonSha256(
    [...byRole.values()]
      .map((record) => ({ id: record._id, recordHash: record.recordHash }))
      .sort((left, right) => left.id.localeCompare(right.id))
  );
  if (manifest) {
    if (
      clean(manifest?._id) !== REPAIR_ID ||
      manifest?.backupCollection !== BACKUP_COLLECTION ||
      Number(manifest?.backupRecordCount) !== expectedRoles.length ||
      manifest?.backupSetSha256 !== backupSetSha256
    ) {
      fail(
        "The manifest no longer binds the exact permanent backup set.",
        "AGODA_PAID_MANIFEST_INVALID"
      );
    }
    for (const record of records) {
      if (manifest?.backupRecordHashes?.[record.role] !== record.recordHash) {
        fail(
          `Manifest hash mismatch for ${record.role}.`,
          "AGODA_PAID_MANIFEST_INVALID"
        );
      }
    }
  }
  return { byRole, backupSetSha256 };
}

function manifestImmutableBasis(plan, records, backupSetSha256) {
  return {
    version: 1,
    repairId: REPAIR_ID,
    releaseSha: plan.releaseSha,
    executionFingerprint: plan.execution.executionFingerprint,
    treeSha: plan.execution.treeSha,
    planHash: plan.planHash,
    targetSetHash: plan.targetSetHash,
    proofPlannedAt: new Date(plan.plannedAt),
    targetCount: plan.scopes.length,
    targetScopes: plan.scopes.map(planScopeEntry),
    backupCollection: BACKUP_COLLECTION,
    backupRecordCount: records.length,
    backupRecordHashes: Object.fromEntries(
      records.map((record) => [record.role, record.recordHash])
    ),
    backupSetSha256,
    vendorApiCalls: 0,
  };
}

function buildManifest(plan, records) {
  const verified = verifyBackupRecords(records, null, plan.targets);
  const immutable = manifestImmutableBasis(
    plan,
    records,
    verified.backupSetSha256
  );
  return {
    _id: REPAIR_ID,
    ...immutable,
    manifestHash: canonicalEjsonSha256(immutable),
    state: "backing_up",
    createdAt: new Date(plan.plannedAt),
  };
}

function assertManifestMatchesPlan(manifest, plan, allowedStates) {
  const immutable = {
    version: manifest?.version,
    repairId: manifest?.repairId,
    releaseSha: manifest?.releaseSha,
    executionFingerprint: manifest?.executionFingerprint,
    treeSha: manifest?.treeSha,
    planHash: manifest?.planHash,
    targetSetHash: manifest?.targetSetHash,
    proofPlannedAt: manifest?.proofPlannedAt,
    targetCount: manifest?.targetCount,
    targetScopes: manifest?.targetScopes,
    backupCollection: manifest?.backupCollection,
    backupRecordCount: manifest?.backupRecordCount,
    backupRecordHashes: manifest?.backupRecordHashes,
    backupSetSha256: manifest?.backupSetSha256,
    vendorApiCalls: manifest?.vendorApiCalls,
  };
  if (
    clean(manifest?._id) !== REPAIR_ID ||
    !allowedStates.includes(manifest?.state) ||
    manifest?.releaseSha !== plan.releaseSha ||
    manifest?.executionFingerprint !== plan.execution.executionFingerprint ||
    manifest?.treeSha !== plan.execution.treeSha ||
    manifest?.planHash !== plan.planHash ||
    manifest?.targetSetHash !== plan.targetSetHash ||
    canonicalEjsonSha256(immutable) !== manifest?.manifestHash
  ) {
    fail(
      "The permanent repair manifest conflicts with the exact plan.",
      "AGODA_PAID_MANIFEST_CONFLICT"
    );
  }
  return true;
}

async function readBackupRecords(db, targets = EXACT_TARGETS, session = null) {
  const collection = db.collection(BACKUP_COLLECTION);
  const records = [];
  for (const target of targets) {
    for (const kind of [
      "reservation_before",
      "hotelrunner_event_evidence",
      "hotelrunner_mirror_evidence",
      "authenticated_agoda_audit_evidence",
    ]) {
      const record = await collection.findOne(
        { _id: `${REPAIR_ID}:${backupRole(target, kind)}` },
        primaryReadOptions(session)
      );
      if (record) records.push(record);
    }
  }
  return records;
}

function finalizeReadyPlan({
  releaseSha,
  execution,
  plannedAt,
  scopes,
  targets,
}) {
  const targetSetHash = canonicalEjsonSha256(targets);
  const provisional = {
    state: "ready",
    repairId: REPAIR_ID,
    releaseSha: lower(releaseSha),
    execution,
    plannedAt: new Date(plannedAt),
    targets,
    targetSetHash,
    scopes,
  };
  const backupRecords = buildBackupRecords(provisional);
  const { backupSetSha256 } = verifyBackupRecords(
    backupRecords,
    null,
    targets
  );
  const proofBasis = {
    version: 1,
    repairId: REPAIR_ID,
    releaseSha: lower(releaseSha),
    treeSha: execution.treeSha,
    executionFingerprint: execution.executionFingerprint,
    plannedAt: new Date(plannedAt),
    targetSetHash,
    backupSetSha256,
    scopes: scopes.map(planScopeEntry),
    vendorApiCalls: 0,
  };
  return {
    ...provisional,
    backupRecords,
    backupSetSha256,
    planHash: canonicalEjsonSha256(proofBasis),
  };
}

async function loadAndVerifyBackup(db, plan, session = null) {
  const manifest = await db
    .collection(MANIFEST_COLLECTION)
    .findOne({ _id: REPAIR_ID }, primaryReadOptions(session));
  if (!manifest) {
    fail(
      "The permanent repair manifest is missing.",
      "AGODA_PAID_MANIFEST_MISSING"
    );
  }
  assertManifestMatchesPlan(manifest, plan, [
    "backing_up",
    "backed_up",
    "applying",
    "applied",
  ]);
  const records = await readBackupRecords(db, plan.targets, session);
  const verified = verifyBackupRecords(records, manifest, plan.targets);
  return { manifest, records, ...verified };
}

async function loadPlan({
  db,
  releaseSha,
  execution,
  plannedAt,
  targets = EXACT_TARGETS,
  session = null,
} = {}) {
  if (!db || !Array.isArray(targets) || targets.length !== 2) {
    fail("The exact two-target database scope is required.");
  }
  const normalizedExecution = assertExecution(execution, releaseSha);
  const hotel = await exactOne(
    db.collection(COLLECTIONS.hotel),
    { _id: objectId(EXPECTED_HOTEL_ID) },
    "target hotel",
    session
  );
  assertHotel(hotel, targets);
  const rawScopes = [];
  for (const target of targets) {
    // Transaction sessions cannot safely run parallel MongoDB operations.
    // Keep this deterministic for both dry run and apply revalidation.
    // eslint-disable-next-line no-await-in-loop
    rawScopes.push(await loadRawScope(db, target, session));
  }
  const currentHashes = rawScopes.map((scope) =>
    canonicalEjsonSha256(scope.reservation)
  );
  const allOriginal = currentHashes.every(
    (hash, index) => hash === targets[index].reservationDocumentHash
  );
  if (allOriginal) {
    const scopes = rawScopes.map((scope) =>
      buildReadyScope(scope, {
        plannedAt,
        releaseSha,
        hotel,
      })
    );
    const plan = finalizeReadyPlan({
      releaseSha,
      execution: normalizedExecution,
      plannedAt,
      scopes,
      targets,
    });
    const existingManifest = await db
      .collection(MANIFEST_COLLECTION)
      .findOne({ _id: REPAIR_ID }, primaryReadOptions(session));
    if (existingManifest) {
      const backup = await loadAndVerifyBackup(db, plan, session);
      plan.backup = backup;
    }
    return plan;
  }

  const manifest = await db
    .collection(MANIFEST_COLLECTION)
    .findOne({ _id: REPAIR_ID }, primaryReadOptions(session));
  if (!manifest) {
    fail(
      "A target changed without this repair's permanent manifest.",
      "AGODA_PAID_TARGET_DRIFT"
    );
  }
  const manifestPlannedAt = exactDate(
    manifest.proofPlannedAt,
    "manifest proof timestamp"
  );
  const records = await readBackupRecords(db, targets, session);
  const preliminary = verifyBackupRecords(records, manifest, targets);
  const scopes = rawScopes.map((rawScope) => {
    const originalRecord = preliminary.byRole.get(
      backupRole(rawScope.target, "reservation_before")
    );
    if (
      !originalRecord ||
      originalRecord.originalHash !== rawScope.target.reservationDocumentHash
    ) {
      fail(
        `${rawScope.target.key} permanent original does not match the audited target.`,
        "AGODA_PAID_BACKUP_INVALID"
      );
    }
    return buildReadyScope(
      { ...rawScope, reservation: cloneBson(originalRecord.originalDocument) },
      {
        plannedAt: manifestPlannedAt,
        releaseSha,
        hotel,
      }
    );
  });
  const originalPlan = finalizeReadyPlan({
    releaseSha,
    execution: normalizedExecution,
    plannedAt: manifestPlannedAt,
    scopes,
    targets,
  });
  assertManifestMatchesPlan(manifest, originalPlan, ["applying", "applied"]);
  const allApplied = rawScopes.every(
    (scope, index) =>
      canonicalEjsonSha256(scope.reservation) === scopes[index].expectedHash
  );
  if (!allApplied) {
    fail(
      "The two reservations are in a mixed or foreign state; no automatic write is allowed.",
      "AGODA_PAID_PARTIAL_OR_FOREIGN_STATE"
    );
  }
  for (let index = 0; index < scopes.length; index += 1) {
    assertMaterialized(
      scopes[index].target,
      scopes[index].originalDocument,
      rawScopes[index].reservation,
      scopes[index].evidence,
      releaseSha
    );
  }
  return {
    ...originalPlan,
    state: "already_applied",
    scopes: scopes.map((scope, index) => ({
      ...scope,
      reservation: rawScopes[index].reservation,
    })),
    backup: { manifest, records, ...preliminary },
  };
}

async function ensureBackup(db, plan, capability) {
  assertMutationCapability(capability, plan);
  const records = plan.backupRecords;
  const expectedManifest = buildManifest(plan, records);
  const manifestCollection = db.collection(MANIFEST_COLLECTION);
  let manifest = await manifestCollection.findOne(
    { _id: REPAIR_ID },
    primaryReadOptions()
  );
  if (!manifest) {
    try {
      assertMutationCapability(capability, plan);
      await manifestCollection.insertOne(
        cloneBson(expectedManifest),
        majorityWriteOptions()
      );
      manifest = expectedManifest;
    } catch (_error) {
      manifest = await manifestCollection.findOne(
        { _id: REPAIR_ID },
        primaryReadOptions()
      );
    }
  }
  assertManifestMatchesPlan(manifest, plan, [
    "backing_up",
    "backed_up",
    "applying",
    "applied",
  ]);

  const backupCollection = db.collection(BACKUP_COLLECTION);
  for (const record of records) {
    // eslint-disable-next-line no-await-in-loop
    let saved = await backupCollection.findOne(
      { _id: record._id },
      primaryReadOptions()
    );
    if (!saved) {
      try {
        assertMutationCapability(capability, plan);
        // eslint-disable-next-line no-await-in-loop
        await backupCollection.insertOne(
          cloneBson(record),
          majorityWriteOptions()
        );
        saved = record;
      } catch (_error) {
        // eslint-disable-next-line no-await-in-loop
        saved = await backupCollection.findOne(
          { _id: record._id },
          primaryReadOptions()
        );
      }
    }
    if (
      !saved ||
      saved.recordHash !== record.recordHash ||
      canonicalEjsonSha256(saved) !== canonicalEjsonSha256(record)
    ) {
      fail(
        `Permanent backup ${record.role} conflicts with the exact plan.`,
        "AGODA_PAID_BACKUP_CONFLICT"
      );
    }
  }
  const readback = await readBackupRecords(db, plan.targets);
  verifyBackupRecords(readback, expectedManifest, plan.targets);
  if (manifest.state === "backing_up") {
    assertMutationCapability(capability, plan);
    const result = await manifestCollection.updateOne(
      {
        _id: REPAIR_ID,
        state: "backing_up",
        manifestHash: expectedManifest.manifestHash,
        planHash: plan.planHash,
        backupSetSha256: plan.backupSetSha256,
      },
      { $set: { state: "backed_up", backupVerifiedAt: new Date() } },
      majorityWriteOptions()
    );
    if (Number(result?.matchedCount ?? result?.n ?? 0) !== 1) {
      fail(
        "The manifest changed while completing the permanent backup.",
        "AGODA_PAID_MANIFEST_CAS_FAILED"
      );
    }
  }
  const verified = await loadAndVerifyBackup(db, plan);
  if (!["backed_up", "applying", "applied"].includes(verified.manifest.state)) {
    fail(
      "The permanent backup was not fully verified before apply.",
      "AGODA_PAID_BACKUP_INCOMPLETE"
    );
  }
  return verified;
}

async function verifyImmutableEvidenceAgainstBackup(
  db,
  plan,
  backup,
  session = null
) {
  for (const scope of plan.scopes) {
    for (const [kind, collection] of [
      ["hotelrunner_event_evidence", COLLECTIONS.event],
      ["hotelrunner_mirror_evidence", COLLECTIONS.mirror],
      ["authenticated_agoda_audit_evidence", COLLECTIONS.audit],
    ]) {
      const record = backup.byRole.get(backupRole(scope.target, kind));
      // eslint-disable-next-line no-await-in-loop
      const current = await db.collection(collection).findOne(
        { _id: objectId(record.documentId) },
        primaryReadOptions(session)
      );
      if (
        !current ||
        canonicalEjsonSha256(current) !== record.originalHash ||
        canonicalEjsonSha256(current) !==
          canonicalEjsonSha256(record.originalDocument)
      ) {
        fail(
          `${scope.target.key} ${kind} changed after permanent backup.`,
          "AGODA_PAID_IMMUTABLE_EVIDENCE_DRIFT"
        );
      }
    }
  }
  return true;
}

function collectNullPaths(value, pathText = "", output = []) {
  if (value === null) {
    if (pathText) output.push(pathText);
    return output;
  }
  if (!value || typeof value !== "object") return output;
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      collectNullPaths(
        entry,
        pathText ? `${pathText}.${index}` : String(index),
        output
      )
    );
    return output;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return output;
  for (const [key, entry] of Object.entries(value)) {
    collectNullPaths(entry, pathText ? `${pathText}.${key}` : key, output);
  }
  return output;
}

function buildFullDocumentCasFilter(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    fail("A full BSON document is required for exact CAS.");
  }
  const rootKeys = Object.keys(document).sort();
  return {
    $and: [
      cloneBson(document),
      {
        $expr: {
          $and: [
            { $eq: [{ $size: { $objectToArray: "$$ROOT" } }, rootKeys.length] },
            {
              $setEquals: [
                {
                  $map: {
                    input: { $objectToArray: "$$ROOT" },
                    as: "field",
                    in: "$$field.k",
                  },
                },
                rootKeys,
              ],
            },
          ],
        },
      },
      ...collectNullPaths(document).map((pathName) => ({
        [pathName]: { $exists: true },
      })),
    ],
  };
}

async function readReservationById(db, target) {
  return db.collection(COLLECTIONS.reservation).findOne(
    { _id: objectId(target.reservationMongoId) },
    primaryReadOptions()
  );
}

async function replaceWithHashReadback({
  db,
  target,
  before,
  after,
  beforeHash,
  afterHash,
  capability,
  plan,
  compensation = false,
}) {
  if (compensation) assertMutationCapabilityBinding(capability, plan);
  else assertMutationCapability(capability, plan);
  let acknowledgementError = null;
  try {
    const result = await db.collection(COLLECTIONS.reservation).replaceOne(
      buildFullDocumentCasFilter(before),
      cloneBson(after),
      majorityWriteOptions()
    );
    const matched = Number(result?.matchedCount ?? result?.n ?? 0);
    const modified = Number(result?.modifiedCount ?? result?.nModified ?? 0);
    if (result?.acknowledged === false || matched !== 1 || modified !== 1) {
      throw new Error("full-document CAS did not replace exactly one document");
    }
  } catch (error) {
    acknowledgementError = error;
  }
  const observed = await readReservationById(db, target);
  const observedHash = observed ? canonicalEjsonSha256(observed) : "";
  if (observedHash === afterHash) {
    return {
      document: observed,
      acknowledgementLost: Boolean(acknowledgementError),
    };
  }
  if (observedHash === beforeHash) {
    const error = new Error(
      `${target.key} exact CAS did not commit${
        acknowledgementError ? `: ${acknowledgementError.message}` : "."
      }`
    );
    error.code = "AGODA_PAID_CAS_REJECTED";
    error.writeResolution = "before";
    throw error;
  }
  const error = new Error(
    `${target.key} live reservation is neither the exact before nor after document.`
  );
  error.code = "AGODA_PAID_MANUAL_INTERVENTION_REQUIRED";
  error.writeResolution = "changed_or_missing";
  error.observedHash = observedHash;
  throw error;
}

async function classifyReservationDocuments(db, plan) {
  const classifications = [];
  for (const scope of plan.scopes) {
    // eslint-disable-next-line no-await-in-loop
    const observed = await readReservationById(db, scope.target);
    const observedHash = observed ? canonicalEjsonSha256(observed) : "";
    classifications.push({
      scope,
      state:
        observedHash === scope.originalHash
          ? "original"
          : observedHash === scope.expectedHash
            ? "repaired"
            : "changed_or_missing",
      observedHash,
    });
  }
  return classifications;
}

async function restoreManifestToBackedUp(db, plan, capability) {
  assertMutationCapabilityBinding(capability, plan);
  const collection = db.collection(MANIFEST_COLLECTION);
  const result = await collection.updateOne(
    {
      _id: REPAIR_ID,
      state: "applying",
      planHash: plan.planHash,
      backupSetSha256: plan.backupSetSha256,
    },
    {
      $set: { state: "backed_up", compensationVerifiedAt: new Date() },
      $unset: { applyStartedAt: "" },
    },
    majorityWriteOptions()
  );
  if (Number(result?.matchedCount ?? result?.n ?? 0) !== 1) {
    const observed = await collection.findOne(
      { _id: REPAIR_ID },
      primaryReadOptions()
    );
    if (observed?.state !== "backed_up" || observed?.planHash !== plan.planHash) {
      fail(
        "Compensation restored reservations but could not restore manifest state.",
        "AGODA_PAID_MANIFEST_RECOVERY_REQUIRED"
      );
    }
  }
}

async function compensateStandaloneApply({ db, plan, capability, cause }) {
  const initial = await classifyReservationDocuments(db, plan);
  if (initial.some((entry) => entry.state === "changed_or_missing")) {
    fail(
      `Standalone compensation found a foreign reservation state: ${cause.message}`,
      "AGODA_PAID_MANUAL_INTERVENTION_REQUIRED"
    );
  }
  for (const classification of [...initial].reverse()) {
    if (classification.state !== "repaired") continue;
    const scope = classification.scope;
    // Compensation remains authorized after proof expiry because it can only
    // restore the exact durable original from the exact repaired hash.
    // eslint-disable-next-line no-await-in-loop
    await replaceWithHashReadback({
      db,
      target: scope.target,
      before: scope.expectedDocument,
      after: scope.originalDocument,
      beforeHash: scope.expectedHash,
      afterHash: scope.originalHash,
      capability,
      plan,
      compensation: true,
    });
  }
  const final = await classifyReservationDocuments(db, plan);
  if (!final.every((entry) => entry.state === "original")) {
    fail(
      `Standalone compensation could not restore both exact originals: ${cause.message}`,
      "AGODA_PAID_COMPENSATION_FAILED"
    );
  }
  await restoreManifestToBackedUp(db, plan, capability);
  const error = new Error(
    `Standalone apply failed and both exact originals were verified restored: ${cause.message}`
  );
  error.code = "AGODA_PAID_REPAIR_COMPENSATED";
  throw error;
}

async function claimApplyingManifest(db, plan, capability) {
  assertMutationCapability(capability, plan);
  const collection = db.collection(MANIFEST_COLLECTION);
  const result = await collection.updateOne(
    {
      _id: REPAIR_ID,
      state: "backed_up",
      manifestHash: plan.backup.manifest.manifestHash,
      planHash: plan.planHash,
      backupSetSha256: plan.backupSetSha256,
    },
    { $set: { state: "applying", applyStartedAt: new Date() } },
    majorityWriteOptions()
  );
  if (Number(result?.matchedCount ?? result?.n ?? 0) !== 1) {
    fail(
      "The backed-up manifest could not be claimed for apply.",
      "AGODA_PAID_MANIFEST_CAS_FAILED"
    );
  }
}

async function finalizeAppliedManifest(db, plan, capability) {
  assertMutationCapability(capability, plan);
  const collection = db.collection(MANIFEST_COLLECTION);
  const appliedDocumentHashes = Object.fromEntries(
    plan.scopes.map((scope) => [scope.target.key, scope.expectedHash])
  );
  const result = await collection.updateOne(
    {
      _id: REPAIR_ID,
      state: "applying",
      planHash: plan.planHash,
      backupSetSha256: plan.backupSetSha256,
    },
    {
      $set: {
        state: "applied",
        appliedAt: new Date(),
        appliedDocumentHashes,
        vendorApiCalls: 0,
      },
    },
    majorityWriteOptions()
  );
  if (Number(result?.matchedCount ?? result?.n ?? 0) !== 1) {
    const observed = await collection.findOne(
      { _id: REPAIR_ID },
      primaryReadOptions()
    );
    if (
      observed?.state !== "applied" ||
      canonicalEjsonSha256(observed?.appliedDocumentHashes || {}) !==
        canonicalEjsonSha256(appliedDocumentHashes)
    ) {
      fail(
        "Reservations were repaired but the applied manifest transition is unresolved.",
        "AGODA_PAID_MANIFEST_RECOVERY_REQUIRED"
      );
    }
  }
}

async function verifyAppliedState(db, plan, backup) {
  await verifyImmutableEvidenceAgainstBackup(db, plan, backup);
  for (const scope of plan.scopes) {
    // eslint-disable-next-line no-await-in-loop
    const observed = await readReservationById(db, scope.target);
    if (!observed || canonicalEjsonSha256(observed) !== scope.expectedHash) {
      fail(
        `${scope.target.key} post-apply reservation hash changed.`,
        "AGODA_PAID_POSTVERIFY_FAILED"
      );
    }
    assertMaterialized(
      scope.target,
      scope.originalDocument,
      observed,
      scope.evidence,
      plan.releaseSha
    );
  }
  return true;
}

async function applyRepairPlan({ db, plan, capability }) {
  if (plan.state === "already_applied") {
    return {
      state: "already_applied",
      changed: 0,
      backupSetSha256: plan.backup.backupSetSha256,
      vendorApiCalls: 0,
    };
  }
  if (plan.state !== "ready") fail("Only an exact ready plan can be applied.");
  assertMutationCapability(capability, plan);
  const backup = await ensureBackup(db, plan, capability);
  plan.backup = backup;

  // This is the final mandatory gate before any reservation mutation: all
  // eight full backup documents are hash-verified, and the six live immutable
  // source documents still byte-match their backed-up originals.
  verifyBackupRecords(backup.records, backup.manifest, plan.targets);
  await verifyImmutableEvidenceAgainstBackup(db, plan, backup);
  const livePlan = await loadPlan({
    db,
    releaseSha: plan.releaseSha,
    execution: plan.execution,
    plannedAt: plan.plannedAt,
    targets: plan.targets,
  });
  if (livePlan.state !== "ready" || livePlan.planHash !== plan.planHash) {
    fail(
      "Live state no longer matches the exact dry-run proof.",
      "AGODA_PAID_PROOF_MISMATCH"
    );
  }
  livePlan.backup = backup;
  await claimApplyingManifest(db, livePlan, capability);
  let acknowledgementsRecovered = 0;
  try {
    for (const scope of livePlan.scopes) {
      // eslint-disable-next-line no-await-in-loop
      const resolution = await replaceWithHashReadback({
        db,
        target: scope.target,
        before: scope.originalDocument,
        after: scope.expectedDocument,
        beforeHash: scope.originalHash,
        afterHash: scope.expectedHash,
        capability,
        plan: livePlan,
      });
      if (resolution.acknowledgementLost) acknowledgementsRecovered += 1;
    }
  } catch (error) {
    return compensateStandaloneApply({
      db,
      plan: livePlan,
      capability,
      cause: error,
    });
  }
  await verifyAppliedState(db, livePlan, backup);
  await finalizeAppliedManifest(db, livePlan, capability);
  const finalBackup = await loadAndVerifyBackup(db, livePlan);
  if (finalBackup.manifest.state !== "applied") {
    fail(
      "Post-apply manifest verification failed.",
      "AGODA_PAID_POSTVERIFY_FAILED"
    );
  }
  await verifyAppliedState(db, livePlan, finalBackup);
  return {
    state: "applied",
    changed: livePlan.scopes.length,
    acknowledgementsRecovered,
    backupSetSha256: finalBackup.backupSetSha256,
    vendorApiCalls: 0,
  };
}

async function resolveApplyStrategy(admin = mongoose.connection.db?.admin()) {
  if (!admin || typeof admin.command !== "function") {
    fail(
      "MongoDB topology could not be inspected.",
      "AGODA_PAID_TOPOLOGY_UNKNOWN"
    );
  }
  const hello = await admin.command({ hello: 1 });
  if (hello?.isWritablePrimary !== true && hello?.ismaster !== true) {
    fail(
      "The repair must connect to the writable primary.",
      "AGODA_PAID_PRIMARY_REQUIRED"
    );
  }
  return "serialized_full_document_cas";
}

function targetSummary(scope) {
  return {
    otaBookingId: scope.target.otaBookingId,
    reservationMongoId: scope.target.reservationMongoId,
    reservationBeforeHash: scope.originalHash,
    reservationExpectedHash: scope.expectedHash,
    evidenceHash: scope.evidence.evidenceHash,
    eventHash: scope.target.eventDocumentHash,
    mirrorHash: scope.target.mirrorDocumentHash,
    auditHash: scope.target.inboundAuditDocumentHash,
    currency: "SAR",
    conversion: { rateToSar: 1, source: "identity" },
    grossTotalSar: scope.target.grossTotalSar,
    rootTotalSar: scope.target.rootTotalSar,
    payoutTotalSar: scope.target.payoutTotalSar,
    otaExpenseTotalSar: scope.target.otaExpenseTotalSar,
    explicitOtaCommissionSar: scope.target.otaCommissionSar,
    unclassifiedDeductionSar: scope.target.unclassifiedDeductionSar,
    daily: scope.target.daily,
  };
}

function sanitizedOutput(plan, mode, proof = "") {
  return {
    mode,
    state: plan.state,
    repairId: REPAIR_ID,
    releaseSha: plan.releaseSha,
    executionFingerprint: plan.execution.executionFingerprint,
    targetSetHash: plan.targetSetHash,
    planHash: plan.planHash,
    proof:
      mode === "dry_run" && plan.state === "ready" ? proof : undefined,
    proofExpiresInMinutes:
      mode === "dry_run" && plan.state === "ready"
        ? PROOF_MAX_AGE_MS / 60_000
        : undefined,
    applyStrategy: "serialized_full_document_cas",
    targetCount: plan.scopes.length,
    backupCollection: BACKUP_COLLECTION,
    backupRecordCount: 8,
    backupSetSha256: plan.backupSetSha256,
    targets: plan.scopes.map(targetSummary),
    mutatesReservations: true,
    createsReservations: false,
    preservesGuestLifecyclePaymentVccSettlementAndRootBase: true,
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
  return mongoose.connection.db;
}

async function main(
  argv = process.argv.slice(2),
  {
    clock = () => new Date(),
    connect = connectDatabase,
    disconnect = async () => mongoose.disconnect(),
    attest = attestExecutionCheckout,
    topology = resolveApplyStrategy,
  } = {}
) {
  const options = parseArguments(argv);
  const execution = assertExecution(
    attest({ releaseSha: options.releaseSha }),
    options.releaseSha
  );
  const now = exactDate(clock(), "repair clock");
  const proofDetails = options.apply ? parseProof(options.proof, now) : null;
  const plannedAt = proofDetails?.plannedAt || now;
  const database =
    process.env.DATABASE || process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!database) fail("Missing DATABASE/MONGO connection string.");
  let connected = false;
  try {
    const db = await connect(database);
    connected = true;
    const strategy = await topology();
    if (strategy !== "serialized_full_document_cas") {
      fail("The approved standalone CAS strategy could not be established.");
    }
    const plan = await loadPlan({
      db,
      releaseSha: options.releaseSha,
      execution,
      plannedAt,
    });
    const generatedProof = proofToken(plan);
    if (
      options.apply &&
      (proofDetails.planHash !== plan.planHash ||
        options.proof !== generatedProof)
    ) {
      fail(
        "Live exact scope does not match the supplied dry-run proof.",
        "AGODA_PAID_PROOF_MISMATCH"
      );
    }
    console.log(
      JSON.stringify(
        sanitizedOutput(
          plan,
          options.apply ? "apply" : "dry_run",
          generatedProof
        ),
        null,
        2
      )
    );
    if (!options.apply) {
      return { state: "dry_run", plan, proof: generatedProof };
    }
    const capability = createMutationCapability({
      plan,
      proofDetails,
      execution,
      clock,
    });
    const result = await applyRepairPlan({ db, plan, capability });
    console.log(
      JSON.stringify(
        {
          state: result.state,
          repairId: REPAIR_ID,
          releaseSha: plan.releaseSha,
          changed: result.changed,
          acknowledgementsRecovered:
            Number(result.acknowledgementsRecovered || 0),
          backupSetSha256: result.backupSetSha256,
          vendorApiCalls: 0,
        },
        null,
        2
      )
    );
    return result;
  } finally {
    if (connected) await disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("[agoda-paid-commercial-materialization] stopped", {
      code: clean(error?.code || "AGODA_PAID_COMMERCIAL_REPAIR_FAILED").slice(
        0,
        100
      ),
      message: clean(error?.message || "Unknown repair failure").slice(0, 500),
    });
    process.exitCode = 1;
  });
}

module.exports = {
  BACKUP_COLLECTION,
  COLLECTIONS,
  EXACT_TARGETS,
  EXPECTED_HOTEL_ID,
  MANIFEST_COLLECTION,
  PROOF_MAX_AGE_MS,
  REPAIR_ID,
  REQUIRED_MATCH_FIELDS,
  TARGET_SET_HASH,
  applyDottedSet,
  applyRepairPlan,
  assertAuthenticatedEvidence,
  assertEnvelope,
  assertMaterialized,
  assertReservationBoundary,
  buildBackupRecords,
  buildExpectedMaterialization,
  buildFullDocumentCasFilter,
  buildManifest,
  canonicalEjsonSha256,
  commercialRows,
  createMutationCapability,
  finalizeReadyPlan,
  immutableRemainder,
  loadPlan,
  main,
  mirrorDailyPayout,
  normalizedFromAudit,
  parseArguments,
  parseProof,
  paymentSettlementSnapshot,
  proofToken,
  rootBaseSnapshot,
  sanitizedOutput,
  seedMirrorSourcePrices,
  sha256,
  verifyBackupRecords,
};
