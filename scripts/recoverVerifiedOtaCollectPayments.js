/** @format */

"use strict";

/**
 * Recover canonical PMS payment accounting when a direct HotelRunner-created
 * reservation already carries complete, authenticated OTA-collect evidence,
 * but the canonical paid fields were left at their pristine unpaid defaults.
 *
 * The scope is discovered from operator-supplied PMS confirmation numbers.
 * No provider, booking identifier, Mongo identifier, or money amount is
 * embedded in this tool.
 *
 * Dry run (the default; performs no writes):
 *   node scripts/recoverVerifiedOtaCollectPayments.js \
 *     --confirmation=<pms-confirmation> \
 *     --release-sha=<exact-deployed-git-sha>
 *
 * Multiple confirmations may be supplied by repeating --confirmation or with
 * a comma-separated --confirmations value. Apply requires the exact unexpired
 * proof emitted by the dry run:
 *   node scripts/recoverVerifiedOtaCollectPayments.js \
 *     --confirmation=<pms-confirmation> \
 *     --release-sha=<same-exact-deployed-git-sha> \
 *     --apply --proof=<dry-run-proof>
 *
 * This script has no HotelRunner/OTA network client. It writes only permanent
 * recovery backups/manifests and the exact linked Reservations documents.
 */

const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const { ObjectId, deserialize, serialize } = require("bson");
const mongoose = require("mongoose");

require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);

const {
  hasCaptureOrSettlementActivity,
  resolvePaymentMapping,
} = require("../services/otaReservationMapper");
const {
  createArchiveFingerprint,
} = require("../services/hotelrunnerFirstOtaFallback");
const {
  normalizeProvider,
  validateOtaCommercialEvidence,
} = require("../services/otaCommercialEvidence");
const {
  canonicalEjsonSha256,
} = require("../services/tripHotelRunnerRepair20260805");

const RECOVERY_KIND = "verified-ota-collect-payment-v1";
const BACKUP_COLLECTION = "ota_verified_collect_payment_recovery_backups_v1";
const MANIFEST_COLLECTION =
  "ota_verified_collect_payment_recovery_manifests_v1";
const PROOF_MAX_AGE_MS = 30 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 1000;
const APPLY_LEASE_MS = 2 * 60 * 1000;
const MAX_CONFIRMATIONS = 100;

const COLLECTIONS = Object.freeze({
  reservations: "reservations",
  audits: "inboundemails",
  jobs: "hotelrunnerotafallbackjobs",
  events: "hotelrunnerevents",
  mirrors: "hotelrunnerreservations",
});

const EXECUTION_PATHS = Object.freeze([
  "scripts/recoverVerifiedOtaCollectPayments.js",
  "services/otaReservationMapper.js",
  "services/otaCommercialEvidence.js",
  "services/tripHotelRunnerRepair20260805.js",
]);

const PAYMENT_BREAKDOWN_KEYS = Object.freeze([
  "paid_online_via_link",
  "paid_at_hotel_cash",
  "paid_at_hotel_card",
  "paid_to_hotel",
  "paid_online_jannatbooking",
  "paid_online_other_platforms",
  "paid_online_via_instapay",
  "paid_no_show",
  "payment_comments",
]);

const PAYMENT_DETAILS_KEYS = Object.freeze(["captured", "onsite_paid_amount"]);

const MUTATION_CAPABILITIES = new WeakSet();

const BSON_DESERIALIZE_OPTIONS = Object.freeze({
  promoteValues: false,
  promoteLongs: false,
  promoteBuffers: false,
  bsonRegExp: true,
});

// Recovery copies are full BSON round trips. In particular, Decimal128, Long,
// Binary/subtypes, regexes and numeric BSON types must never be relaxed through
// JSON/EJSON before a full-document CAS or compensation restore.
function cloneBson(value) {
  if (value === undefined) return undefined;
  return deserialize(
    serialize({ value }, { ignoreUndefined: false }),
    BSON_DESERIALIZE_OPTIONS
  ).value;
}

// Business validation is intentionally performed on a promoted, throw-away
// view. The lossless document above remains authoritative for backup/CAS.
function operationalView(value) {
  if (value === undefined) return undefined;
  return deserialize(serialize({ value }, { ignoreUndefined: false })).value;
}

const clean = (value = "") => String(value?._id || value || "").trim();
const lower = (value = "") => clean(value).toLowerCase();
const upper = (value = "") => clean(value).toUpperCase();
const round2 = (value) => Number(Number(value).toFixed(2));
const sameMoney = (left, right) =>
  Number.isFinite(Number(left)) &&
  Number.isFinite(Number(right)) &&
  Math.abs(round2(left) - round2(right)) <= 0.005;
const sha256 = (value) =>
  crypto
    .createHash("sha256")
    .update(String(value ?? ""), "utf8")
    .digest("hex");

function fail(message, code = "OTA_COLLECT_PAYMENT_RECOVERY_BLOCKED") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function objectId(value, label = "Mongo identifier") {
  const normalized = clean(value);
  if (!ObjectId.isValid(normalized)) {
    fail(`${label} is invalid.`, "OTA_COLLECT_PAYMENT_ID_INVALID");
  }
  return new ObjectId(normalized);
}

function exactDate(value, label = "timestamp") {
  const parsed =
    value instanceof Date ? new Date(value) : new Date(value || "");
  if (!Number.isFinite(parsed.getTime())) {
    fail(`${label} is invalid.`, "OTA_COLLECT_PAYMENT_DATE_INVALID");
  }
  return parsed;
}

function normalizeConfirmation(value) {
  const confirmation = clean(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(confirmation)) {
    fail(
      "Each PMS confirmation must be a bounded machine identifier.",
      "OTA_COLLECT_PAYMENT_CONFIRMATION_INVALID"
    );
  }
  return confirmation.toLowerCase();
}

function parseArguments(argv = []) {
  let apply = false;
  let proof = "";
  let releaseSha = "";
  const confirmations = [];
  for (const raw of argv) {
    const argument = clean(raw);
    if (argument === "--apply") {
      if (apply) {
        fail(
          "--apply may be supplied only once.",
          "OTA_COLLECT_PAYMENT_ARGUMENT_INVALID"
        );
      }
      apply = true;
      continue;
    }
    if (argument.startsWith("--confirmation=")) {
      confirmations.push(argument.slice("--confirmation=".length));
      continue;
    }
    if (argument.startsWith("--confirmations=")) {
      confirmations.push(
        ...argument.slice("--confirmations=".length).split(",")
      );
      continue;
    }
    if (argument.startsWith("--release-sha=")) {
      if (releaseSha) {
        fail(
          "--release-sha may be supplied only once.",
          "OTA_COLLECT_PAYMENT_ARGUMENT_INVALID"
        );
      }
      releaseSha = lower(argument.slice("--release-sha=".length));
      continue;
    }
    if (argument.startsWith("--proof=")) {
      if (proof) {
        fail(
          "--proof may be supplied only once.",
          "OTA_COLLECT_PAYMENT_ARGUMENT_INVALID"
        );
      }
      proof = lower(argument.slice("--proof=".length));
      continue;
    }
    fail(
      "Unsupported recovery argument.",
      "OTA_COLLECT_PAYMENT_ARGUMENT_INVALID"
    );
  }
  const uniqueConfirmations = Array.from(
    new Set(confirmations.map(normalizeConfirmation))
  ).sort();
  if (
    !uniqueConfirmations.length ||
    uniqueConfirmations.length > MAX_CONFIRMATIONS
  ) {
    fail(
      `Supply between 1 and ${MAX_CONFIRMATIONS} unique PMS confirmations.`,
      "OTA_COLLECT_PAYMENT_CONFIRMATIONS_REQUIRED"
    );
  }
  if (!/^[a-f0-9]{40}$/.test(releaseSha)) {
    fail(
      "An exact 40-character --release-sha is required.",
      "OTA_COLLECT_PAYMENT_RELEASE_REQUIRED"
    );
  }
  if (!apply && proof) {
    fail("--proof is apply-only.", "OTA_COLLECT_PAYMENT_ARGUMENT_INVALID");
  }
  if (apply && !/^\d{13}\.[a-f0-9]{64}$/.test(proof)) {
    fail(
      "Apply requires the exact unexpired dry-run proof.",
      "OTA_COLLECT_PAYMENT_PROOF_REQUIRED"
    );
  }
  return { apply, proof, releaseSha, confirmations: uniqueConfirmations };
}

function parseProof(proof, now = new Date()) {
  const match = lower(proof).match(/^(\d{13})\.([a-f0-9]{64})$/);
  if (!match) {
    fail("The dry-run proof is invalid.", "OTA_COLLECT_PAYMENT_PROOF_INVALID");
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
      "OTA_COLLECT_PAYMENT_PROOF_EXPIRED"
    );
  }
  return {
    plannedAt: new Date(plannedAtMs),
    expiresAt: new Date(plannedAtMs + PROOF_MAX_AGE_MS),
    planHash: match[2],
  };
}

const proofToken = (plan) =>
  `${new Date(plan.plannedAt).getTime()}.${plan.planHash}`;

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
          "A recovery dependency is absent from the approved tree.",
          "OTA_COLLECT_PAYMENT_EXECUTION_INVALID"
        );
      }
      return { path: filePath, blobSha: lower(match[1]) };
    });
    if (observedReleaseSha !== lower(releaseSha)) {
      fail(
        "The executing checkout is not the exact approved release.",
        "OTA_COLLECT_PAYMENT_RELEASE_MISMATCH"
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
    if (String(error?.code || "").startsWith("OTA_COLLECT_PAYMENT_"))
      throw error;
    fail(
      "The executing checkout could not be attested.",
      "OTA_COLLECT_PAYMENT_EXECUTION_INVALID"
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
      "OTA_COLLECT_PAYMENT_EXECUTION_DIRTY"
    );
  }
  return {
    releaseSha: lower(execution.releaseSha),
    treeSha: lower(execution.treeSha),
    executionFingerprint: lower(execution.executionFingerprint),
    trackedWorktreeClean: true,
  };
}

const primaryReadOptions = () => ({
  readPreference: "primary",
  readConcern: { level: "majority" },
  ...BSON_DESERIALIZE_OPTIONS,
});
const majorityWriteOptions = () => ({ writeConcern: { w: "majority" } });

async function findMany(collection, filter, limit = 3) {
  const documents = await collection
    .find(filter, primaryReadOptions())
    .limit(limit)
    .toArray();
  return documents.map(cloneBson);
}

async function exactOne(collection, filter, label) {
  const documents = await findMany(collection, filter, 3);
  if (documents.length !== 1) {
    fail(
      `${label} requires exactly one document; found ${documents.length}.`,
      "OTA_COLLECT_PAYMENT_EXACT_ONE_FAILED"
    );
  }
  return documents[0];
}

async function findOnePrimary(collection, filter) {
  const document = await collection.findOne(filter, primaryReadOptions());
  return document ? cloneBson(document) : null;
}

function providerAndExternalIdentity(reservation = {}) {
  const evidence = reservation?.supplierData?.otaCommercialEvidence;
  const validation = evidence
    ? validateOtaCommercialEvidence(evidence)
    : { ok: false };
  if (validation.ok !== true || evidence.verificationState !== "verified") {
    fail(
      "The stored OTA commercial evidence is not fully verified.",
      "OTA_COLLECT_PAYMENT_EVIDENCE_INVALID"
    );
  }
  const provider = normalizeProvider(evidence.provider);
  const providerCandidates = [
    reservation?.supplierData?.otaProvider,
    reservation?.booking_source,
    reservation?.customer_details?.booking_source,
  ]
    .map(normalizeProvider)
    .filter(Boolean);
  if (
    !provider ||
    provider === "hotelrunner" ||
    providerCandidates.some((candidate) => candidate !== provider)
  ) {
    fail(
      "Reservation provider identity conflicts with its authenticated evidence.",
      "OTA_COLLECT_PAYMENT_PROVIDER_CONFLICT"
    );
  }
  const identityPrefix = `${provider}:`;
  const identityExternal = lower(reservation.otaIdentityKey).startsWith(
    identityPrefix
  )
    ? clean(reservation.otaIdentityKey).slice(identityPrefix.length)
    : "";
  const externalCandidates = [
    reservation.reservation_id,
    reservation.customer_details?.confirmation_number2,
    reservation.supplierData?.suppliedBookingNo,
    reservation.supplierData?.otaConfirmationNumber,
    reservation.supplierData?.platformConfirmationNumber,
    identityExternal,
  ]
    .map(clean)
    .filter(Boolean);
  const uniqueExternal = Array.from(new Set(externalCandidates));
  if (uniqueExternal.length !== 1) {
    fail(
      "Reservation OTA confirmation aliases are missing or inconsistent.",
      "OTA_COLLECT_PAYMENT_IDENTITY_CONFLICT"
    );
  }
  const externalConfirmation = uniqueExternal[0];
  if (
    lower(reservation.otaIdentityKey) !==
    `${provider}:${lower(externalConfirmation)}`
  ) {
    fail(
      "The reservation OTA identity key is inconsistent.",
      "OTA_COLLECT_PAYMENT_IDENTITY_CONFLICT"
    );
  }
  return { provider, externalConfirmation, evidence };
}

function meaningfulProcessorActivity(processor = {}) {
  if (!processor || typeof processor !== "object" || Array.isArray(processor)) {
    return false;
  }
  const numericKeys = [
    "charge_count",
    "attempts_count",
    "failed_attempts_count",
    "total_captured_usd",
    "total_captured_sar",
    "captured_total_usd",
    "captured_total_sar",
    "captured_total",
    "amount_usd",
    "amount_sar",
  ];
  const referenceKeys = [
    "last_transaction_id",
    "last_reference_number",
    "last_merchant_transaction_id",
    "last_reconciliation_id",
    "capture_id",
    "transaction_id",
    "authorization_id",
    "auth_id",
    "last_request_id",
  ];
  const timestampKeys = [
    "last_attempt_at",
    "last_success_at",
    "last_failure_at",
    "last_signed_at",
    "last_callback_at",
  ];
  const activeStatus = clean(
    processor.status || processor.last_status
  ).toLowerCase();
  return Boolean(
    processor.charged === true ||
      processor.processing === true ||
      processor.captured === true ||
      processor.authorized === true ||
      processor.outcome_unknown === true ||
      numericKeys.some(
        (key) => Math.abs(Number(processor[key] || 0)) > 0.0001
      ) ||
      referenceKeys.some((key) => clean(processor[key])) ||
      timestampKeys.some(
        (key) =>
          processor[key] !== undefined &&
          processor[key] !== null &&
          processor[key] !== ""
      ) ||
      (activeStatus && activeStatus !== "not_started") ||
      (Array.isArray(processor.attempts) && processor.attempts.length > 0) ||
      (Array.isArray(processor.captures) && processor.captures.length > 0) ||
      (Array.isArray(processor.callbacks) && processor.callbacks.length > 0) ||
      (processor.last_capture && Object.keys(processor.last_capture).length > 0)
  );
}

function meaningfulProtectedValue(value) {
  if (value === null || value === undefined || value === "" || value === false)
    return false;
  if (typeof value === "number") return Math.abs(value) > 0.0001;
  if (typeof value?.valueOf === "function" && Number.isFinite(Number(value))) {
    return Math.abs(Number(value)) > 0.0001;
  }
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function assertPristinePaymentState(reservation = {}) {
  if (
    !sameMoney(reservation.paid_amount, 0) ||
    ![/^$/, /^not paid$/, /^not provided$/].some((pattern) =>
      pattern.test(lower(reservation.payment))
    ) ||
    lower(reservation.financeStatus) !== "not paid"
  ) {
    fail(
      "Canonical paid state is not pristine.",
      "OTA_COLLECT_PAYMENT_STATE_NOT_PRISTINE"
    );
  }
  const paymentDetails = reservation.payment_details;
  if (
    !paymentDetails ||
    Object.keys(paymentDetails).sort().join("|") !==
      [...PAYMENT_DETAILS_KEYS].sort().join("|") ||
    paymentDetails.captured !== false ||
    !sameMoney(paymentDetails.onsite_paid_amount, 0)
  ) {
    fail(
      "Payment details contain activity or an unknown field.",
      "OTA_COLLECT_PAYMENT_SETTLEMENT_ACTIVITY"
    );
  }
  const breakdown = reservation.paid_amount_breakdown;
  if (
    !breakdown ||
    Object.keys(breakdown).sort().join("|") !==
      [...PAYMENT_BREAKDOWN_KEYS].sort().join("|") ||
    PAYMENT_BREAKDOWN_KEYS.filter((key) => key !== "payment_comments").some(
      (key) => !sameMoney(breakdown[key], 0)
    ) ||
    clean(breakdown.payment_comments)
  ) {
    fail(
      "Payment breakdown contains activity or an unknown field.",
      "OTA_COLLECT_PAYMENT_SETTLEMENT_ACTIVITY"
    );
  }
  const cycle = reservation.financial_cycle;
  const allowedCycleKeys = new Set([
    "collectionModel",
    "status",
    "commissionType",
    "commissionValue",
    "commissionAmount",
    "commissionAssigned",
    "commissionAssignedAt",
    "commissionAssignedBy",
    "pmsCollectedAmount",
    "hotelCollectedAmount",
    "hotelPayoutDue",
    "commissionDueToPms",
    "closedAt",
    "closedBy",
    "notes",
    "lastUpdatedAt",
    "lastUpdatedBy",
  ]);
  const cycleHasUnknownActivity = Object.entries(cycle || {}).some(
    ([key, value]) =>
      !allowedCycleKeys.has(key) && meaningfulProtectedValue(value)
  );
  const commission = Number(reservation.commission || 0);
  const commissionAssigned = cycle?.commissionAssigned === true;
  const assignmentAt = commissionAssigned
    ? exactDate(cycle.commissionAssignedAt, "commission assignment timestamp")
    : null;
  const assignmentActor = commissionAssigned
    ? clean(cycle.commissionAssignedBy)
    : "";
  const assignmentTupleValid = commissionAssigned
    ? Boolean(
        assignmentActor &&
          cycle.lastUpdatedAt &&
          exactDate(
            cycle.lastUpdatedAt,
            "commission assignment update timestamp"
          ).getTime() === assignmentAt.getTime() &&
          clean(cycle.lastUpdatedBy) === assignmentActor
      )
    : !meaningfulProtectedValue(cycle?.commissionAssignedAt) &&
      !meaningfulProtectedValue(cycle?.commissionAssignedBy) &&
      !meaningfulProtectedValue(cycle?.lastUpdatedBy);
  if (
    !cycle ||
    cycleHasUnknownActivity ||
    !sameMoney(commission, 0) ||
    lower(cycle.collectionModel) !== "pending" ||
    lower(cycle.status) !== "open" ||
    lower(cycle.commissionType) !== "amount" ||
    !sameMoney(cycle.commissionValue, commission) ||
    !sameMoney(cycle.commissionAmount, commission) ||
    !assignmentTupleValid ||
    !sameMoney(cycle.pmsCollectedAmount, 0) ||
    !sameMoney(cycle.hotelCollectedAmount, 0) ||
    !sameMoney(cycle.hotelPayoutDue, 0) ||
    !sameMoney(cycle.commissionDueToPms, 0) ||
    cycle.closedAt ||
    cycle.closedBy ||
    clean(cycle.notes)
  ) {
    fail(
      "Financial-cycle settlement state is not pristine.",
      "OTA_COLLECT_PAYMENT_SETTLEMENT_ACTIVITY"
    );
  }
  if (
    meaningfulProcessorActivity(reservation.vcc_payment) ||
    meaningfulProcessorActivity(reservation.braintree_payment) ||
    meaningfulProcessorActivity(reservation.bofa_payment?.vcc) ||
    meaningfulProcessorActivity(reservation.bofa_payment?.secure_acceptance) ||
    meaningfulProcessorActivity(reservation.paypal_details) ||
    meaningfulProcessorActivity(reservation.paypal_details?.initial) ||
    meaningfulProcessorActivity(
      reservation.paypal_details?.external_virtual_terminal
    ) ||
    hasCaptureOrSettlementActivity({
      ...reservation,
      financial_cycle: { ...cycle, commissionAssigned: false },
    }) ||
    reservation.moneyTransferredToHotel === true ||
    Boolean(reservation.moneyTransferredAt) ||
    reservation.commissionPaid === true ||
    Boolean(reservation.commissionPaidAt)
  ) {
    fail(
      "Processor, transfer, or settlement activity blocks automatic recovery.",
      "OTA_COLLECT_PAYMENT_SETTLEMENT_ACTIVITY"
    );
  }
  return true;
}

function assertAuthenticatedCollectEvidence({ reservation, audit, identity }) {
  const { provider, externalConfirmation, evidence } = identity;
  const normalized = audit?.normalizedReservation || {};
  const gross = evidence?.roles?.guestGross;
  const payout = evidence?.roles?.hotelPayout;
  const propertyCurrency = upper(reservation.currency);
  const sourceHash = sha256(audit?.bodyText || "");
  if (
    clean(audit?._id) !== clean(evidence?.provenance?.primary?.sourceId) ||
    audit?.senderAuthentication?.authenticatedAligned !== true ||
    normalizeProvider(audit?.senderAuthentication?.trustedProvider) !==
      provider ||
    normalizeProvider(audit?.provider) !== provider ||
    normalizeProvider(normalized.provider) !== provider ||
    clean(audit.confirmationNumber) !== externalConfirmation ||
    clean(normalized.confirmationNumber) !== externalConfirmation ||
    normalized.paymentCollectionModel !== "ota_collect" ||
    audit.paymentCollectionModel !== "ota_collect" ||
    normalized.paidOnline !== true ||
    normalized?.sourcePresence?.paymentCollectionModel !== true ||
    !clean(normalized.paymentInstructions) ||
    (Array.isArray(audit.parseErrors) && audit.parseErrors.length > 0) ||
    (Array.isArray(audit.reconcileErrors) &&
      audit.reconcileErrors.length > 0) ||
    !clean(audit.bodyText) ||
    lower(evidence.sourceType) !== "authenticated_ota_email" ||
    lower(evidence.provenance?.primary?.sourceHash) !== sourceHash ||
    gross?.verified !== true ||
    payout?.verified !== true ||
    upper(gross.propertyCurrency) !== propertyCurrency ||
    upper(payout.propertyCurrency) !== propertyCurrency ||
    !sameMoney(gross.propertyAmount, reservation.total_amount) ||
    !sameMoney(gross.propertyAmount, normalized.totalAmountSar) ||
    !sameMoney(
      gross.propertyAmount,
      normalized.paymentSummary?.totalGuestPaymentAmount
    ) ||
    !sameMoney(payout.propertyAmount, normalized.totalPayoutSar) ||
    !sameMoney(
      payout.propertyAmount,
      normalized.paymentSummary?.totalPayoutAmount
    ) ||
    !sameMoney(
      gross.propertyAmount,
      reservation.supplierData?.otaPaymentSummary?.totalGuestPaymentAmount
    ) ||
    !sameMoney(
      gross.propertyAmount,
      reservation.ota_financial_summary?.paymentSummary?.totalGuestPaymentAmount
    ) ||
    !sameMoney(gross.propertyAmount, reservation.adminPricing?.clientTotal) ||
    !sameMoney(
      gross.propertyAmount,
      reservation.ota_financial_summary?.clientTotal
    )
  ) {
    fail(
      "Authenticated OTA-collect gross evidence does not reconcile exactly.",
      "OTA_COLLECT_PAYMENT_EVIDENCE_MISMATCH"
    );
  }
  return {
    normalized,
    grossAmount: round2(gross.propertyAmount),
    propertyCurrency,
  };
}

function protectedReservationSnapshot(reservation = {}) {
  const copy = cloneBson(reservation);
  delete copy.__v;
  delete copy.payment;
  delete copy.financeStatus;
  delete copy.paid_amount;
  delete copy.paid_amount_breakdown;
  delete copy.financial_cycle;
  delete copy.reservationAuditLog;
  if (copy.supplierData) delete copy.supplierData.otaPaymentCollectionModel;
  return copy;
}

function financialCycleProtectedSnapshot(cycle = {}) {
  const copy = cloneBson(cycle || {});
  for (const key of [
    "collectionModel",
    "pmsCollectedAmount",
    "hotelCollectedAmount",
    "hotelPayoutDue",
    "commissionDueToPms",
  ]) {
    delete copy[key];
  }
  return copy;
}

function recoveryAuditEntry(scope, releaseSha, plannedAt) {
  return {
    at: new Date(plannedAt),
    source: "ota-payment-recovery",
    action: "recovered-verified-ota-collect-payment",
    recoveryKind: RECOVERY_KIND,
    provider: scope.provider,
    otaConfirmationNumber: scope.externalConfirmation,
    inboundEmailId: scope.audit._id,
    hotelRunnerReservationId: scope.mirror.hotelRunnerReservationId,
    evidenceHash: scope.evidence.evidenceHash,
    releaseSha,
  };
}

function buildExpectedReservation(scope, { plannedAt, releaseSha }) {
  const { reservation, normalized, grossAmount, provider } = scope;
  const rootTotal = Number(reservation.sub_total);
  if (!Number.isFinite(rootTotal) || rootTotal < 0) {
    fail("Approved root total is invalid.", "OTA_COLLECT_PAYMENT_ROOT_INVALID");
  }
  const mapping = resolvePaymentMapping(
    {
      ...normalized,
      provider,
      providerLabel:
        normalized.providerLabel ||
        normalized.bookingSource ||
        reservation.booking_source,
      paymentCollectionModel: "ota_collect",
    },
    grossAmount,
    rootTotal,
    Number(reservation.commission || 0)
  );
  if (
    lower(mapping.payment) !== "paid online" ||
    lower(mapping.financeStatus) !== "paid online" ||
    !sameMoney(mapping.paidAmount, grossAmount) ||
    lower(mapping.financialCycle?.collectionModel) !== "pms_collected"
  ) {
    fail(
      "The shared payment mapper did not produce canonical OTA-collect state.",
      "OTA_COLLECT_PAYMENT_MAPPING_INVALID"
    );
  }
  const expected = cloneBson(reservation);
  expected.__v = Number(reservation.__v || 0) + 1;
  expected.payment = mapping.payment;
  expected.financeStatus = mapping.financeStatus;
  expected.paid_amount = mapping.paidAmount;
  expected.paid_amount_breakdown = cloneBson(mapping.paidAmountBreakdown);
  expected.financial_cycle = {
    ...cloneBson(reservation.financial_cycle),
    collectionModel: mapping.financialCycle.collectionModel,
    pmsCollectedAmount: mapping.financialCycle.pmsCollectedAmount,
    hotelCollectedAmount: mapping.financialCycle.hotelCollectedAmount,
    hotelPayoutDue: mapping.financialCycle.hotelPayoutDue,
    commissionDueToPms: mapping.financialCycle.commissionDueToPms,
  };
  expected.supplierData = {
    ...cloneBson(reservation.supplierData),
    otaPaymentCollectionModel: "ota_collect",
  };
  expected.reservationAuditLog = [
    ...(Array.isArray(reservation.reservationAuditLog)
      ? cloneBson(reservation.reservationAuditLog)
      : []),
    recoveryAuditEntry(scope, releaseSha, plannedAt),
  ];
  if (
    canonicalEjsonSha256(protectedReservationSnapshot(expected)) !==
      canonicalEjsonSha256(protectedReservationSnapshot(reservation)) ||
    canonicalEjsonSha256(
      financialCycleProtectedSnapshot(expected.financial_cycle)
    ) !==
      canonicalEjsonSha256(
        financialCycleProtectedSnapshot(reservation.financial_cycle)
      ) ||
    canonicalEjsonSha256(expected.payment_details) !==
      canonicalEjsonSha256(reservation.payment_details)
  ) {
    fail(
      "The planned recovery crossed its payment-only mutation boundary.",
      "OTA_COLLECT_PAYMENT_PROTECTED_STATE_CHANGED"
    );
  }
  return expected;
}

function hasRecoveryAudit(reservation, scope) {
  return (reservation?.reservationAuditLog || []).some(
    (entry) =>
      entry?.action === "recovered-verified-ota-collect-payment" &&
      entry?.recoveryKind === RECOVERY_KIND &&
      entry?.provider === scope.provider &&
      clean(entry?.otaConfirmationNumber) === scope.externalConfirmation &&
      clean(entry?.inboundEmailId) === clean(scope.audit?._id) &&
      clean(entry?.evidenceHash) === clean(scope.evidence?.evidenceHash)
  );
}

function isRecoveredPaymentState(reservation, scope) {
  const gross = scope.grossAmount;
  return Boolean(
    lower(reservation?.payment) === "paid online" &&
      lower(reservation?.financeStatus) === "paid online" &&
      sameMoney(reservation?.paid_amount, gross) &&
      sameMoney(
        reservation?.paid_amount_breakdown?.paid_online_other_platforms,
        gross
      ) &&
      lower(reservation?.financial_cycle?.collectionModel) ===
        "pms_collected" &&
      sameMoney(reservation?.financial_cycle?.pmsCollectedAmount, gross) &&
      sameMoney(
        reservation?.financial_cycle?.hotelPayoutDue,
        reservation?.sub_total
      ) &&
      lower(reservation?.supplierData?.otaPaymentCollectionModel) ===
        "ota_collect" &&
      reservation?.payment_details?.captured === false &&
      sameMoney(reservation?.payment_details?.onsite_paid_amount, 0) &&
      hasRecoveryAudit(reservation, scope)
  );
}

async function loadScope(
  db,
  pmsConfirmation,
  { reservationOverride = null } = {}
) {
  const liveReservation = await exactOne(
    db.collection(COLLECTIONS.reservations),
    { confirmation_number: pmsConfirmation },
    `reservation ${pmsConfirmation}`
  );
  const reservation = reservationOverride
    ? cloneBson(reservationOverride)
    : liveReservation;
  if (clean(liveReservation._id) !== clean(reservation._id)) {
    fail("The resume backup no longer identifies the exact live reservation.");
  }
  const safeReservation = operationalView(reservation);
  if (
    clean(safeReservation.confirmation_number) !== pmsConfirmation ||
    lower(safeReservation?.supplierData?.hotelRunner?.transport) !==
      "hotelrunner_api" ||
    Number(safeReservation?.supplierData?.otaSourceAuthority) !== 4 ||
    lower(safeReservation?.supplierData?.otaAutomationPipeline) !==
      "hotelrunner-background-worker" ||
    lower(safeReservation?.otaPlatformReview?.status) !== "released"
  ) {
    fail(
      `${pmsConfirmation} is not one exact released direct-HotelRunner OTA reservation.`,
      "OTA_COLLECT_PAYMENT_RESERVATION_BOUNDARY_INVALID"
    );
  }
  const identity = providerAndExternalIdentity(safeReservation);
  const sourceId = clean(identity.evidence?.provenance?.primary?.sourceId);
  const audit = await exactOne(
    db.collection(COLLECTIONS.audits),
    { _id: objectId(sourceId, "commercial evidence source audit") },
    `authenticated audit ${sourceId}`
  );
  const safeAudit = operationalView(audit);
  const evidenceResult = assertAuthenticatedCollectEvidence({
    reservation: safeReservation,
    audit: safeAudit,
    identity,
  });
  const bridge =
    safeReservation?.supplierData?.hotelRunnerFirstFallbackCommercialBridge;
  if (
    clean(bridge?.inboundEmailId) !== clean(safeAudit._id) ||
    clean(safeReservation?.supplierData?.otaInboundEmailId) !==
      clean(safeAudit._id) ||
    clean(safeReservation?.supplierData?.otaLastInboundEmailId) !==
      clean(safeAudit._id)
  ) {
    fail(
      "The direct OTA audit is not the exact HotelRunner commercial bridge.",
      "OTA_COLLECT_PAYMENT_BRIDGE_INVALID"
    );
  }
  const job = await exactOne(
    db.collection(COLLECTIONS.jobs),
    { _id: objectId(bridge.jobId, "HotelRunner fallback job") },
    `fallback job ${clean(bridge.jobId)}`
  );
  const safeJob = operationalView(job);
  const mirror = await exactOne(
    db.collection(COLLECTIONS.mirrors),
    { reservationMongoId: reservation._id },
    `HotelRunner mirror for ${pmsConfirmation}`
  );
  const safeMirror = operationalView(mirror);
  const event = await exactOne(
    db.collection(COLLECTIONS.events),
    { _id: objectId(safeJob.hotelRunnerEventId, "HotelRunner event") },
    `HotelRunner event ${clean(safeJob.hotelRunnerEventId)}`
  );
  const safeEvent = operationalView(event);
  let archive;
  try {
    archive = createArchiveFingerprint({
      identity: {
        hotelId: clean(safeReservation.hotelId),
        provider: identity.provider,
        confirmationNumber: identity.externalConfirmation,
      },
      audit: safeAudit,
    });
  } catch (_error) {
    fail(
      "The authenticated direct-OTA archive fingerprint cannot be reproduced.",
      "OTA_COLLECT_PAYMENT_ARCHIVE_INVALID"
    );
  }
  if (
    lower(safeJob.status) !== "completed_api" ||
    lower(safeJob.lastDecision) !==
      "completed_api_with_email_commercial_evidence" ||
    clean(safeJob.lastErrorCode) ||
    clean(safeJob.lastErrorMessage) ||
    clean(safeJob.inboundEmailId) !== clean(safeAudit._id) ||
    clean(safeJob.reservationMongoId) !== clean(safeReservation._id) ||
    clean(safeJob.hotelRunnerMirrorId) !== clean(safeMirror._id) ||
    clean(safeEvent._id) !== clean(safeJob.hotelRunnerEventId) ||
    clean(safeEvent.mirrorId) !== clean(safeMirror._id) ||
    clean(safeEvent.reservationMongoId) !== clean(safeReservation._id) ||
    clean(safeMirror.reservationMongoId) !== clean(safeReservation._id) ||
    clean(safeMirror.hotelRunnerReservationId) !==
      clean(safeReservation?.supplierData?.hotelRunner?.reservationId) ||
    clean(safeMirror.providerNumber) !== identity.externalConfirmation ||
    !["created", "updated"].includes(lower(safeMirror.projectionStatus)) ||
    !["created", "updated"].includes(lower(safeEvent?.result?.status)) ||
    safeEvent.integrityConflict === true ||
    lower(safeAudit.intent) !== "new_reservation" ||
    lower(safeAudit.eventType) !== "new" ||
    lower(safeAudit?.hotelRunnerFirstFallback?.status) !== "completed_api" ||
    clean(safeAudit?.hotelRunnerFirstFallback?.jobId) !== clean(safeJob._id) ||
    clean(safeJob.hotelId) !== clean(safeReservation.hotelId) ||
    normalizeProvider(safeJob.provider) !== identity.provider ||
    clean(safeJob.confirmationNumber) !== identity.externalConfirmation ||
    clean(safeJob.lookupConfirmationNumber) !==
      archive.lookupConfirmationNumber ||
    lower(safeJob.inboundEmailHash) !== lower(archive.inboundEmailHash) ||
    lower(safeJob.normalizedReservationHash) !==
      lower(archive.normalizedReservationHash) ||
    lower(safeJob.resolvedHotelProofHash) !==
      lower(archive.resolvedHotelProofHash) ||
    lower(safeJob.archiveFingerprint) !== lower(archive.archiveFingerprint) ||
    Number(bridge.version) !== 1 ||
    lower(bridge.inboundEmailHash) !== lower(archive.inboundEmailHash) ||
    lower(bridge.normalizedReservationHash) !==
      lower(archive.normalizedReservationHash) ||
    lower(bridge.resolvedHotelProofHash) !==
      lower(archive.resolvedHotelProofHash) ||
    lower(bridge.archiveFingerprint) !== lower(archive.archiveFingerprint)
  ) {
    fail(
      "HotelRunner event, mirror, job, and reservation linkage is inconsistent.",
      "OTA_COLLECT_PAYMENT_HOTELRUNNER_LINK_INVALID"
    );
  }
  const scope = {
    pmsConfirmation,
    provider: identity.provider,
    externalConfirmation: identity.externalConfirmation,
    evidence: identity.evidence,
    reservation,
    audit,
    job,
    event,
    mirror,
    sourceHashes: {
      audit: canonicalEjsonSha256(audit),
      job: canonicalEjsonSha256(job),
      event: canonicalEjsonSha256(event),
      mirror: canonicalEjsonSha256(mirror),
    },
    archiveFingerprint: archive.archiveFingerprint,
    normalizedReservationHash: archive.normalizedReservationHash,
    normalized: evidenceResult.normalized,
    grossAmount: evidenceResult.grossAmount,
    propertyCurrency: evidenceResult.propertyCurrency,
  };
  if (isRecoveredPaymentState(safeReservation, scope)) {
    return {
      ...scope,
      state: "already_recovered",
      originalHash: canonicalEjsonSha256(reservation),
      expected: reservation,
      expectedHash: canonicalEjsonSha256(reservation),
    };
  }
  assertPristinePaymentState(safeReservation);
  return { ...scope, state: "ready" };
}

function finalizeScope(scope, { plannedAt, releaseSha }) {
  if (scope.state === "already_recovered") return scope;
  const expected = buildExpectedReservation(scope, { plannedAt, releaseSha });
  return {
    ...scope,
    originalHash: canonicalEjsonSha256(scope.reservation),
    expected,
    expectedHash: canonicalEjsonSha256(expected),
    protectedHash: canonicalEjsonSha256(
      protectedReservationSnapshot(scope.reservation)
    ),
  };
}

function planScopeSummary(scope) {
  return {
    pmsConfirmation: scope.pmsConfirmation,
    provider: scope.provider,
    externalConfirmation: scope.externalConfirmation,
    reservationId: clean(scope.reservation._id),
    inboundEmailId: clean(scope.audit._id),
    fallbackJobId: clean(scope.job._id),
    hotelRunnerEventId: clean(scope.event._id),
    hotelRunnerMirrorId: clean(scope.mirror._id),
    hotelRunnerReservationId: clean(scope.mirror.hotelRunnerReservationId),
    currency: scope.propertyCurrency,
    grossAmount: scope.grossAmount,
    rootTotal: round2(scope.reservation.sub_total),
    evidenceHash: scope.evidence.evidenceHash,
    archiveFingerprint: scope.archiveFingerprint,
    normalizedReservationHash: scope.normalizedReservationHash,
    sourceHashes: cloneBson(scope.sourceHashes),
    originalHash: scope.originalHash,
    expectedHash: scope.expectedHash,
    state: scope.state,
  };
}

async function loadPlan({
  db,
  confirmations,
  releaseSha,
  execution,
  plannedAt,
  reservationOverrides = new Map(),
} = {}) {
  if (!db || !Array.isArray(confirmations) || !confirmations.length) {
    fail(
      "Database and confirmations are required.",
      "OTA_COLLECT_PAYMENT_PLAN_INVALID"
    );
  }
  const safeExecution = assertExecution(execution, releaseSha);
  const scopes = [];
  for (const confirmation of confirmations) {
    // Mongo sessions and standalone production both benefit from deterministic,
    // serialized reads here.
    // eslint-disable-next-line no-await-in-loop
    const loaded = await loadScope(db, confirmation, {
      reservationOverride: reservationOverrides.get(confirmation) || null,
    });
    scopes.push(finalizeScope(loaded, { plannedAt, releaseSha }));
  }
  const ready = scopes.filter((scope) => scope.state === "ready");
  const basis = {
    version: 1,
    recoveryKind: RECOVERY_KIND,
    releaseSha: lower(releaseSha),
    treeSha: safeExecution.treeSha,
    executionFingerprint: safeExecution.executionFingerprint,
    plannedAt: new Date(plannedAt),
    confirmations: [...confirmations],
    scopes: scopes.map(planScopeSummary),
    vendorApiCalls: 0,
  };
  return {
    ...basis,
    execution: safeExecution,
    scopes,
    state: ready.length ? "ready" : "already_applied",
    planHash: canonicalEjsonSha256(basis),
  };
}

async function loadResumeState({
  db,
  proofDetails,
  confirmations,
  releaseSha,
  execution,
}) {
  const manifest = await findOnePrimary(db.collection(MANIFEST_COLLECTION), {
    _id: proofDetails.planHash,
  });
  if (!manifest) return { manifest: null, reservationOverrides: new Map() };
  if (
    manifest.recoveryKind !== RECOVERY_KIND ||
    manifest.releaseSha !== releaseSha ||
    manifest.executionFingerprint !== execution.executionFingerprint ||
    exactDate(manifest.plannedAt, "resume plan timestamp").getTime() !==
      proofDetails.plannedAt.getTime() ||
    canonicalEjsonSha256(manifest.confirmations) !==
      canonicalEjsonSha256(confirmations) ||
    !["backing_up", "backed_up", "applying", "applied"].includes(manifest.state)
  ) {
    fail(
      "The durable recovery manifest cannot resume this exact proof.",
      "OTA_COLLECT_PAYMENT_MANIFEST_INVALID"
    );
  }
  const targets = Array.isArray(manifest.targets) ? manifest.targets : [];
  if (targets.length !== confirmations.length) {
    fail("The resume manifest target count is inconsistent.");
  }
  const reservationOverrides = new Map();
  for (const confirmation of confirmations) {
    const target = targets.find(
      (entry) => clean(entry.pmsConfirmation) === confirmation
    );
    if (!target)
      fail("The resume manifest is missing an exact confirmation target.");
    // eslint-disable-next-line no-await-in-loop
    const backup = await findOnePrimary(db.collection(BACKUP_COLLECTION), {
      _id: `${proofDetails.planHash}:${clean(target.reservationId)}`,
    });
    if (!backup) {
      if (manifest.state !== "backing_up") {
        fail("A resumable manifest is missing its full reservation backup.");
      }
      continue;
    }
    if (
      backup.planHash !== proofDetails.planHash ||
      backup.originalHash !== target.originalHash ||
      canonicalEjsonSha256(backup.originalDocument) !== target.originalHash ||
      clean(backup.originalDocument?.confirmation_number) !== confirmation ||
      clean(backup.originalDocument?._id) !== clean(target.reservationId)
    ) {
      fail("A resume backup failed its exact hash and identity fence.");
    }
    reservationOverrides.set(confirmation, backup.originalDocument);
  }
  return { manifest, reservationOverrides };
}

function createMutationCapability({ plan, proofDetails, execution, clock }) {
  if (
    proofDetails.planHash !== plan.planHash ||
    proofToken(plan) !==
      `${proofDetails.plannedAt.getTime()}.${proofDetails.planHash}` ||
    execution.executionFingerprint !== plan.execution.executionFingerprint
  ) {
    fail(
      "The mutation capability does not match the dry-run plan.",
      "OTA_COLLECT_PAYMENT_PROOF_MISMATCH"
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

function assertMutationCapability(
  capability,
  plan,
  { allowExpiredCompensation = false } = {}
) {
  if (
    !capability ||
    !MUTATION_CAPABILITIES.has(capability) ||
    capability.planHash !== plan.planHash ||
    capability.releaseSha !== plan.releaseSha ||
    capability.executionFingerprint !== plan.execution.executionFingerprint
  ) {
    fail(
      "The database mutation boundary is not authorized.",
      "OTA_COLLECT_PAYMENT_WRITE_UNAUTHORIZED"
    );
  }
  const now = exactDate(capability.clock(), "mutation clock");
  if (
    !allowExpiredCompensation &&
    (now < capability.proofIssuedAt || now > capability.proofExpiresAt)
  ) {
    fail(
      "The dry-run proof expired before mutation.",
      "OTA_COLLECT_PAYMENT_PROOF_EXPIRED"
    );
  }
  return now;
}

function collectNullPaths(value, pathText = "", output = []) {
  if (value === null) {
    if (pathText) output.push(pathText);
    return output;
  }
  if (
    !value ||
    typeof value !== "object" ||
    value instanceof Date ||
    value instanceof ObjectId
  ) {
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      collectNullPaths(
        entry,
        pathText ? `${pathText}.${index}` : `${index}`,
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

function backupRecord(plan, scope) {
  const basis = {
    version: 1,
    recoveryKind: RECOVERY_KIND,
    planHash: plan.planHash,
    pmsConfirmation: scope.pmsConfirmation,
    reservationId: clean(scope.reservation._id),
    originalHash: scope.originalHash,
    expectedHash: scope.expectedHash,
    releaseSha: plan.releaseSha,
    createdAt: new Date(plan.plannedAt),
  };
  return {
    _id: `${plan.planHash}:${clean(scope.reservation._id)}`,
    ...basis,
    backupRecordHash: canonicalEjsonSha256(basis),
    originalDocument: cloneBson(scope.reservation),
  };
}

function manifestDocument(plan) {
  return {
    _id: plan.planHash,
    version: 1,
    recoveryKind: RECOVERY_KIND,
    state: "backing_up",
    planHash: plan.planHash,
    releaseSha: plan.releaseSha,
    treeSha: plan.treeSha,
    executionFingerprint: plan.executionFingerprint,
    plannedAt: new Date(plan.plannedAt),
    confirmations: [...plan.confirmations],
    targets: plan.scopes
      .filter((scope) => scope.state === "ready")
      .map(planScopeSummary),
    backupCount: plan.scopes.filter((scope) => scope.state === "ready").length,
    createdAt: new Date(plan.plannedAt),
  };
}

function assertManifest(manifest, plan, states) {
  if (
    !manifest ||
    manifest._id !== plan.planHash ||
    manifest.planHash !== plan.planHash ||
    manifest.recoveryKind !== RECOVERY_KIND ||
    manifest.releaseSha !== plan.releaseSha ||
    manifest.executionFingerprint !== plan.executionFingerprint ||
    !states.includes(manifest.state) ||
    canonicalEjsonSha256(manifest.confirmations) !==
      canonicalEjsonSha256(plan.confirmations) ||
    canonicalEjsonSha256(manifest.targets) !==
      canonicalEjsonSha256(
        plan.scopes
          .filter((scope) => scope.state === "ready")
          .map(planScopeSummary)
      )
  ) {
    fail(
      "The durable recovery manifest does not match the exact plan.",
      "OTA_COLLECT_PAYMENT_MANIFEST_INVALID"
    );
  }
  return manifest;
}

async function verifyBackups(db, plan) {
  const ready = plan.scopes.filter((scope) => scope.state === "ready");
  for (const scope of ready) {
    // eslint-disable-next-line no-await-in-loop
    const record = await findOnePrimary(db.collection(BACKUP_COLLECTION), {
      _id: `${plan.planHash}:${clean(scope.reservation._id)}`,
    });
    const expected = backupRecord(plan, scope);
    if (
      !record ||
      record.backupRecordHash !== expected.backupRecordHash ||
      canonicalEjsonSha256(record.originalDocument) !== scope.originalHash ||
      record.expectedHash !== scope.expectedHash
    ) {
      fail(
        "A permanent reservation backup is missing or corrupt.",
        "OTA_COLLECT_PAYMENT_BACKUP_INVALID"
      );
    }
  }
  return true;
}

async function ensureBackups(db, plan, capability) {
  assertMutationCapability(capability, plan);
  const manifests = db.collection(MANIFEST_COLLECTION);
  const desired = manifestDocument(plan);
  try {
    await manifests.insertOne(desired, majorityWriteOptions());
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }
  let manifest = await findOnePrimary(manifests, { _id: plan.planHash });
  assertManifest(manifest, plan, [
    "backing_up",
    "backed_up",
    "applying",
    "applied",
  ]);
  if (["applying", "applied"].includes(manifest.state)) {
    await verifyBackups(db, plan);
    return manifest;
  }
  for (const scope of plan.scopes.filter((entry) => entry.state === "ready")) {
    const record = backupRecord(plan, scope);
    try {
      // eslint-disable-next-line no-await-in-loop
      await db
        .collection(BACKUP_COLLECTION)
        .insertOne(record, majorityWriteOptions());
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }
  }
  await verifyBackups(db, plan);
  assertMutationCapability(capability, plan);
  const backedUpAt = new Date(capability.clock());
  let transitionError = null;
  try {
    await manifests.updateOne(
      { _id: plan.planHash, state: "backing_up" },
      { $set: { state: "backed_up", backedUpAt } },
      majorityWriteOptions()
    );
  } catch (error) {
    transitionError = error;
  }
  manifest = await findOnePrimary(manifests, { _id: plan.planHash });
  if (
    transitionError &&
    !(
      manifest?.state === "backed_up" &&
      exactDate(manifest.backedUpAt).getTime() === backedUpAt.getTime()
    )
  ) {
    throw transitionError;
  }
  return assertManifest(manifest, plan, ["backed_up", "applying", "applied"]);
}

async function verifyWritablePrimary(db) {
  const hello = await db.admin().command({ hello: 1 });
  if (hello?.isWritablePrimary !== true || hello?.secondary === true) {
    fail(
      "Apply requires the current writable MongoDB primary.",
      "OTA_COLLECT_PAYMENT_PRIMARY_REQUIRED"
    );
  }
  return {
    topology: hello.setName
      ? "replica_set"
      : hello.msg === "isdbgrid"
      ? "mongos"
      : "standalone",
    writablePrimary: true,
  };
}

async function renewApplyLease(
  db,
  plan,
  capability,
  ownerToken,
  { allowExpiredCompensation = false } = {}
) {
  const now = assertMutationCapability(capability, plan, {
    allowExpiredCompensation,
  });
  const collection = db.collection(MANIFEST_COLLECTION);
  const observed = await findOnePrimary(collection, { _id: plan.planHash });
  if (
    observed?.state !== "applying" ||
    observed.applyOwnerToken !== ownerToken ||
    exactDate(observed.applyLeaseUntil, "apply lease") <= now
  ) {
    fail(
      "The recovery process no longer owns a live apply lease.",
      "OTA_COLLECT_PAYMENT_APPLY_LEASED"
    );
  }
  const leaseUntil = new Date(now.getTime() + APPLY_LEASE_MS);
  let writeError = null;
  try {
    await collection.updateOne(
      {
        _id: plan.planHash,
        state: "applying",
        applyOwnerToken: ownerToken,
        applyLeaseUntil: observed.applyLeaseUntil,
      },
      { $set: { applyLeaseUntil: leaseUntil } },
      majorityWriteOptions()
    );
  } catch (error) {
    writeError = error;
  }
  const renewed = await findOnePrimary(collection, { _id: plan.planHash });
  if (
    renewed?.state !== "applying" ||
    renewed.applyOwnerToken !== ownerToken ||
    exactDate(renewed.applyLeaseUntil, "renewed apply lease").getTime() !==
      leaseUntil.getTime()
  ) {
    if (writeError) throw writeError;
    fail(
      "The apply lease renewal was not committed exactly.",
      "OTA_COLLECT_PAYMENT_APPLY_LEASED"
    );
  }
  return renewed;
}

async function revalidateScopeSources(db, scope) {
  const refreshed = await loadScope(db, scope.pmsConfirmation, {
    reservationOverride: scope.reservation,
  });
  if (
    refreshed.state !== "ready" ||
    canonicalEjsonSha256(refreshed.sourceHashes) !==
      canonicalEjsonSha256(scope.sourceHashes) ||
    refreshed.evidence.evidenceHash !== scope.evidence.evidenceHash ||
    refreshed.archiveFingerprint !== scope.archiveFingerprint ||
    refreshed.normalizedReservationHash !== scope.normalizedReservationHash ||
    !sameMoney(refreshed.grossAmount, scope.grossAmount)
  ) {
    fail(
      "The authenticated source graph changed after planning.",
      "OTA_COLLECT_PAYMENT_SOURCE_FENCE_CHANGED"
    );
  }
  return true;
}

async function acquireApplyManifest(db, manifest, plan, capability) {
  const now = assertMutationCapability(capability, plan);
  const ownerToken = crypto.randomBytes(32).toString("hex");
  const leaseUntil = new Date(now.getTime() + APPLY_LEASE_MS);
  const collection = db.collection(MANIFEST_COLLECTION);
  let result = null;
  let acquireError = null;
  try {
    result = await collection.updateOne(
      { _id: plan.planHash, state: "backed_up" },
      {
        $set: {
          state: "applying",
          applyOwnerToken: ownerToken,
          applyLeaseUntil: leaseUntil,
          applyingAt: now,
        },
      },
      majorityWriteOptions()
    );
  } catch (error) {
    acquireError = error;
  }
  if (acquireError) {
    const readback = await findOnePrimary(collection, { _id: plan.planHash });
    if (
      readback?.state === "applying" &&
      readback.applyOwnerToken === ownerToken &&
      exactDate(readback.applyLeaseUntil).getTime() === leaseUntil.getTime()
    ) {
      return { manifest: readback, ownerToken };
    }
    throw acquireError;
  }
  if (Number(result?.matchedCount ?? result?.n ?? 0) !== 1) {
    const observed = await findOnePrimary(collection, { _id: plan.planHash });
    assertManifest(observed, plan, ["applying", "applied"]);
    if (observed.state === "applied")
      return { manifest: observed, ownerToken: "" };
    const lease = exactDate(observed.applyLeaseUntil, "apply lease");
    if (lease > now) {
      fail(
        "Another recovery process owns the active apply lease.",
        "OTA_COLLECT_PAYMENT_APPLY_LEASED"
      );
    }
    let takeoverError = null;
    try {
      result = await collection.updateOne(
        {
          _id: plan.planHash,
          state: "applying",
          applyOwnerToken: observed.applyOwnerToken,
          applyLeaseUntil: observed.applyLeaseUntil,
        },
        { $set: { applyOwnerToken: ownerToken, applyLeaseUntil: leaseUntil } },
        majorityWriteOptions()
      );
    } catch (error) {
      takeoverError = error;
    }
    if (takeoverError) {
      const readback = await findOnePrimary(collection, { _id: plan.planHash });
      if (
        readback?.state === "applying" &&
        readback.applyOwnerToken === ownerToken &&
        exactDate(readback.applyLeaseUntil).getTime() === leaseUntil.getTime()
      ) {
        return { manifest: readback, ownerToken };
      }
      throw takeoverError;
    }
    if (Number(result?.matchedCount ?? result?.n ?? 0) !== 1) {
      fail(
        "The expired apply lease could not be claimed.",
        "OTA_COLLECT_PAYMENT_APPLY_LEASED"
      );
    }
  }
  const owned = await findOnePrimary(collection, { _id: plan.planHash });
  if (owned.state !== "applying" || owned.applyOwnerToken !== ownerToken) {
    fail("The apply manifest ownership could not be verified.");
  }
  return { manifest: owned, ownerToken };
}

async function readReservationById(db, id) {
  return findOnePrimary(db.collection(COLLECTIONS.reservations), {
    _id: objectId(id, "reservation"),
  });
}

async function classifyReservation(db, scope) {
  const document = await readReservationById(db, scope.reservation._id);
  const hash = document ? canonicalEjsonSha256(document) : "";
  if (hash === scope.originalHash) return { state: "original", document, hash };
  if (hash === scope.expectedHash) return { state: "expected", document, hash };
  return { state: document ? "foreign" : "missing", document, hash };
}

async function replaceWithReadback({
  db,
  before,
  after,
  beforeHash,
  afterHash,
  plan,
  capability,
  compensation = false,
}) {
  assertMutationCapability(capability, plan, {
    allowExpiredCompensation: compensation,
  });
  let acknowledgementError = null;
  try {
    const result = await db
      .collection(COLLECTIONS.reservations)
      .replaceOne(
        buildFullDocumentCasFilter(before),
        cloneBson(after),
        majorityWriteOptions()
      );
    const matched = Number(result?.matchedCount ?? result?.n ?? 0);
    const modified = Number(result?.modifiedCount ?? result?.nModified ?? 0);
    if (result?.acknowledged === false || matched !== 1 || modified !== 1) {
      throw new Error(
        "full-document CAS did not replace exactly one reservation"
      );
    }
  } catch (error) {
    acknowledgementError = error;
  }
  const observed = await readReservationById(db, before._id);
  const observedHash = observed ? canonicalEjsonSha256(observed) : "";
  if (observedHash === afterHash) {
    return {
      document: observed,
      acknowledgementLost: Boolean(acknowledgementError),
    };
  }
  if (observedHash === beforeHash) {
    const error = new Error(
      `Exact reservation CAS did not commit${
        acknowledgementError ? `: ${acknowledgementError.message}` : "."
      }`
    );
    error.code = "OTA_COLLECT_PAYMENT_CAS_REJECTED";
    throw error;
  }
  const error = new Error(
    "Reservation CAS is ambiguous: live state is neither the exact before nor after document."
  );
  error.code = "OTA_COLLECT_PAYMENT_MANUAL_INTERVENTION_REQUIRED";
  error.observedHash = observedHash;
  throw error;
}

async function compensateAppliedScopes(db, plan, capability, ownerToken) {
  const results = [];
  const issues = [];
  for (const scope of [...plan.scopes].reverse()) {
    if (scope.state !== "ready") continue;
    // eslint-disable-next-line no-await-in-loop
    try {
      await renewApplyLease(db, plan, capability, ownerToken, {
        allowExpiredCompensation: true,
      });
    } catch (error) {
      const manualError = new Error(
        "Compensation lost its exact apply lease before every safe restore could be attempted."
      );
      manualError.code = "OTA_COLLECT_PAYMENT_MANUAL_INTERVENTION_REQUIRED";
      manualError.compensationResults = results;
      manualError.compensationIssues = [
        ...issues,
        {
          pmsConfirmation: scope.pmsConfirmation,
          reason: "apply_lease_unavailable",
          errorCode: clean(
            error.code || "OTA_COLLECT_PAYMENT_APPLY_LEASED"
          ).slice(0, 100),
        },
      ];
      throw manualError;
    }
    // eslint-disable-next-line no-await-in-loop
    let current;
    try {
      current = await classifyReservation(db, scope);
    } catch (error) {
      issues.push({
        pmsConfirmation: scope.pmsConfirmation,
        reason: "classification_failed",
        errorCode: clean(error.code || "OTA_COLLECT_PAYMENT_READ_FAILED").slice(
          0,
          100
        ),
      });
      results.push({
        pmsConfirmation: scope.pmsConfirmation,
        state: "unclassified",
        changed: false,
      });
      continue;
    }
    if (current.state === "original") {
      results.push({
        pmsConfirmation: scope.pmsConfirmation,
        state: "original",
        changed: false,
      });
      continue;
    }
    if (current.state !== "expected") {
      issues.push({
        pmsConfirmation: scope.pmsConfirmation,
        reason: "foreign_or_missing_state",
        observedState: current.state,
      });
      results.push({
        pmsConfirmation: scope.pmsConfirmation,
        state: current.state,
        changed: false,
      });
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      await replaceWithReadback({
        db,
        before: scope.expected,
        after: scope.reservation,
        beforeHash: scope.expectedHash,
        afterHash: scope.originalHash,
        plan,
        capability,
        compensation: true,
      });
      results.push({
        pmsConfirmation: scope.pmsConfirmation,
        state: "restored",
        changed: true,
      });
    } catch (error) {
      let after = { state: "unclassified" };
      try {
        // eslint-disable-next-line no-await-in-loop
        after = await classifyReservation(db, scope);
      } catch (_readbackError) {
        // The durable backup and exact expected hash remain the recovery fence.
      }
      if (after.state === "original") {
        results.push({
          pmsConfirmation: scope.pmsConfirmation,
          state: "restored",
          changed: true,
          acknowledgementRecovered: true,
        });
        continue;
      }
      issues.push({
        pmsConfirmation: scope.pmsConfirmation,
        reason: "restore_failed",
        observedState: after.state,
        errorCode: clean(
          error.code || "OTA_COLLECT_PAYMENT_CAS_REJECTED"
        ).slice(0, 100),
      });
      results.push({
        pmsConfirmation: scope.pmsConfirmation,
        state: after.state,
        changed: false,
      });
    }
  }
  if (issues.length) {
    const error = new Error(
      "Compensation restored every safely restorable reservation; foreign or failed scopes require manual intervention."
    );
    error.code = "OTA_COLLECT_PAYMENT_MANUAL_INTERVENTION_REQUIRED";
    error.compensationResults = results;
    error.compensationIssues = issues;
    throw error;
  }
  return results;
}

async function markManifest(db, plan, ownerToken, state, fields = {}) {
  const filter = {
    _id: plan.planHash,
    state: "applying",
    applyOwnerToken: ownerToken,
  };
  const collection = db.collection(MANIFEST_COLLECTION);
  let result = null;
  let writeError = null;
  try {
    result = await collection.updateOne(
      filter,
      { $set: { state, ...fields } },
      majorityWriteOptions()
    );
  } catch (error) {
    writeError = error;
  }
  const observed = await findOnePrimary(collection, { _id: plan.planHash });
  const exactFields =
    Boolean(observed) &&
    Object.entries(fields).every(
      ([key, value]) =>
        canonicalEjsonSha256(observed[key]) === canonicalEjsonSha256(value)
    );
  if (observed?.state === state && exactFields) return observed;
  if (writeError) throw writeError;
  if (Number(result?.matchedCount ?? result?.n ?? 0) !== 1) {
    fail("The recovery manifest state transition could not be verified.");
  }
  fail(
    "The majority manifest readback did not match the requested transition."
  );
}

async function applyPlan(db, plan, capability) {
  assertMutationCapability(capability, plan);
  await verifyWritablePrimary(db);
  let manifest = await ensureBackups(db, plan, capability);
  const ownership = await acquireApplyManifest(db, manifest, plan, capability);
  manifest = ownership.manifest;
  const { ownerToken } = ownership;
  if (manifest.state === "applied") {
    for (const scope of plan.scopes.filter(
      (entry) => entry.state === "ready"
    )) {
      // eslint-disable-next-line no-await-in-loop
      const classified = await classifyReservation(db, scope);
      if (classified.state !== "expected") {
        fail("Applied manifest does not match live reservation state.");
      }
    }
    return { state: "already_applied", changed: 0, vendorApiCalls: 0 };
  }
  let changed = 0;
  try {
    for (const scope of plan.scopes) {
      if (scope.state !== "ready") continue;
      // eslint-disable-next-line no-await-in-loop
      await renewApplyLease(db, plan, capability, ownerToken);
      // eslint-disable-next-line no-await-in-loop
      await revalidateScopeSources(db, scope);
      // eslint-disable-next-line no-await-in-loop
      const current = await classifyReservation(db, scope);
      if (current.state === "expected") continue;
      if (current.state !== "original") {
        const error = new Error(
          `${scope.pmsConfirmation} changed after dry-run/backup fencing.`
        );
        error.code = "OTA_COLLECT_PAYMENT_MANUAL_INTERVENTION_REQUIRED";
        throw error;
      }
      // eslint-disable-next-line no-await-in-loop
      await replaceWithReadback({
        db,
        before: scope.reservation,
        after: scope.expected,
        beforeHash: scope.originalHash,
        afterHash: scope.expectedHash,
        plan,
        capability,
      });
      changed += 1;
    }
    for (const scope of plan.scopes.filter(
      (entry) => entry.state === "ready"
    )) {
      // eslint-disable-next-line no-await-in-loop
      await renewApplyLease(db, plan, capability, ownerToken);
      // eslint-disable-next-line no-await-in-loop
      await revalidateScopeSources(db, scope);
      // eslint-disable-next-line no-await-in-loop
      const verified = await classifyReservation(db, scope);
      if (verified.state !== "expected") {
        fail(
          "Post-write verification did not prove the exact expected reservation."
        );
      }
    }
    await renewApplyLease(db, plan, capability, ownerToken);
    await markManifest(db, plan, ownerToken, "applied", {
      appliedAt: new Date(capability.clock()),
      changed,
    });
    return { state: "applied", changed, vendorApiCalls: 0 };
  } catch (error) {
    try {
      const compensation = await compensateAppliedScopes(
        db,
        plan,
        capability,
        ownerToken
      );
      await renewApplyLease(db, plan, capability, ownerToken, {
        allowExpiredCompensation: true,
      });
      await markManifest(db, plan, ownerToken, "compensated", {
        compensatedAt: new Date(capability.clock()),
        compensation,
        failureCode: clean(
          error.code || "OTA_COLLECT_PAYMENT_APPLY_FAILED"
        ).slice(0, 100),
      });
      error.compensated = true;
    } catch (compensationError) {
      try {
        await markManifest(
          db,
          plan,
          ownerToken,
          "manual_intervention_required",
          {
            manualInterventionAt: new Date(capability.clock()),
            failureCode: clean(compensationError.code || error.code).slice(
              0,
              100
            ),
            compensation: Array.isArray(compensationError.compensationResults)
              ? cloneBson(compensationError.compensationResults)
              : [],
            manualInterventionIssues: Array.isArray(
              compensationError.compensationIssues
            )
              ? cloneBson(compensationError.compensationIssues)
              : [
                  {
                    reason: "compensation_failed_without_structured_readback",
                  },
                ],
          }
        );
      } catch (_manifestError) {
        // The exact live-state readback remains the authoritative stop condition.
      }
      compensationError.applyCause = error;
      throw compensationError;
    }
    throw error;
  }
}

function sanitizedOutput(plan, mode, proof = "") {
  return {
    mode,
    recoveryKind: RECOVERY_KIND,
    state: plan.state,
    releaseSha: plan.releaseSha,
    planHash: plan.planHash,
    proof: mode === "dry_run" && plan.state === "ready" ? proof : undefined,
    proofExpiresInMinutes:
      mode === "dry_run" && plan.state === "ready"
        ? PROOF_MAX_AGE_MS / 60_000
        : undefined,
    targetCount: plan.scopes.length,
    readyCount: plan.scopes.filter((scope) => scope.state === "ready").length,
    targets: plan.scopes.map((scope) => ({
      pmsConfirmation: scope.pmsConfirmation,
      otaConfirmation: scope.externalConfirmation,
      provider: scope.provider,
      currency: scope.propertyCurrency,
      paidAmount: scope.grossAmount,
      state: scope.state,
    })),
    backupCollection: BACKUP_COLLECTION,
    manifestCollection: MANIFEST_COLLECTION,
    mutatesReservationCount: plan.scopes.filter(
      (scope) => scope.state === "ready"
    ).length,
    mutatesLifecyclePricingRoomGuestHotelRunner: false,
    mutatesOnlyCanonicalPaymentSupplierMarkerAndAudit: true,
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
    db: injectedDb = null,
    skipConnect = false,
  } = {}
) {
  const options = parseArguments(argv);
  const execution = assertExecution(
    attestExecution({ releaseSha: options.releaseSha }),
    options.releaseSha
  );
  const now = clock();
  const proofDetails = options.apply ? parseProof(options.proof, now) : null;
  const plannedAt = proofDetails?.plannedAt || now;
  const database =
    process.env.DATABASE || process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!database && !skipConnect) {
    fail(
      "Missing DATABASE/MONGO connection string.",
      "OTA_COLLECT_PAYMENT_DATABASE_REQUIRED"
    );
  }
  let connectedHere = false;
  try {
    if (!skipConnect) {
      await connect(database);
      connectedHere = true;
    }
    const db = injectedDb || mongoose.connection.db;
    const resumeState = options.apply
      ? await loadResumeState({
          db,
          proofDetails,
          confirmations: options.confirmations,
          releaseSha: options.releaseSha,
          execution,
        })
      : { manifest: null, reservationOverrides: new Map() };
    const plan = await loadPlan({
      db,
      confirmations: options.confirmations,
      releaseSha: options.releaseSha,
      execution,
      plannedAt,
      reservationOverrides: resumeState.reservationOverrides,
    });
    const generatedProof = proofToken(plan);
    if (
      options.apply &&
      (plan.planHash !== proofDetails.planHash ||
        generatedProof !== options.proof)
    ) {
      fail(
        "Live scope no longer matches the supplied dry-run proof.",
        "OTA_COLLECT_PAYMENT_PROOF_MISMATCH"
      );
    }
    if (resumeState.manifest) {
      assertManifest(resumeState.manifest, plan, [
        "backing_up",
        "backed_up",
        "applying",
        "applied",
      ]);
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
      return {
        state: plan.state === "ready" ? "dry_run_ready" : "already_applied",
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
    const result = await applyPlan(db, plan, capability);
    console.log(
      JSON.stringify(
        {
          state: result.state,
          recoveryKind: RECOVERY_KIND,
          releaseSha: plan.releaseSha,
          changed: result.changed,
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
    console.error("[verified-ota-collect-payment-recovery] stopped", {
      code: clean(error?.code || "OTA_COLLECT_PAYMENT_RECOVERY_FAILED").slice(
        0,
        100
      ),
      message: clean(error?.message || "Unknown recovery failure").slice(
        0,
        500
      ),
      compensated: error?.compensated === true,
    });
    process.exitCode = 1;
  });
}

module.exports = {
  APPLY_LEASE_MS,
  BACKUP_COLLECTION,
  COLLECTIONS,
  MANIFEST_COLLECTION,
  PROOF_MAX_AGE_MS,
  RECOVERY_KIND,
  applyPlan,
  assertAuthenticatedCollectEvidence,
  assertExecution,
  assertPristinePaymentState,
  attestExecutionCheckout,
  backupRecord,
  buildExpectedReservation,
  buildFullDocumentCasFilter,
  classifyReservation,
  cloneBson,
  compensateAppliedScopes,
  createMutationCapability,
  financialCycleProtectedSnapshot,
  finalizeScope,
  isRecoveredPaymentState,
  loadPlan,
  loadResumeState,
  loadScope,
  main,
  manifestDocument,
  meaningfulProcessorActivity,
  parseArguments,
  parseProof,
  planScopeSummary,
  proofToken,
  protectedReservationSnapshot,
  sha256,
  revalidateScopeSources,
  renewApplyLease,
  verifyBackups,
};
