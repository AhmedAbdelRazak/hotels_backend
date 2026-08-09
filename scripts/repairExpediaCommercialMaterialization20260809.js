/** @format */

"use strict";

/**
 * Guarded v2 materialization for the single audited Expedia reservation.
 *
 * This script never calls Expedia, HotelRunner, or an exchange-rate service. It
 * accepts only a newly collected, explicit, supervised read-only Expedia job
 * whose stored conversion evidence is trusted, verified, hash-backed, fresh,
 * and internally reconciled. The v1 source-only manifest and backup set are
 * prerequisites and are never modified.
 *
 * Dry run:
 *   node scripts/repairExpediaCommercialMaterialization20260809.js
 *     --release-sha=<exact-merged-sha>
 *     --portal-job-id=<fresh-job-object-id>
 *     --portal-job-number=<fresh-job-number>
 *
 * Apply / rollback use the proof emitted by the immediately preceding dry run
 * and require --repair-id=expedia-commercial-materialization-20260809-v2.
 */

const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const { ObjectId } = require("bson");
const mongoose = require("mongoose");

require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);

const v1 = require("./repairExpediaCommercialEnrichment20260809");
const {
  canonicalEjsonSha256,
  cloneBson,
} = require("../services/recentOtaInboundRecovery20260805");
const {
  buildAuthenticatedProviderCommercialEvidence,
  validateOtaCommercialEvidence,
} = require("../services/otaCommercialEvidence");
const {
  hasCaptureOrSettlementActivity,
} = require("../services/otaReservationMapper");

const REPAIR_ID = "expedia-commercial-materialization-20260809-v2";
const BACKUP_COLLECTION = "ota_expedia_commercial_repair_backup_20260809_v2";
const MANIFEST_COLLECTION = v1.MANIFEST_COLLECTION;
const PROOF_MAX_AGE_MS = 30 * 60 * 1000;
const COLLECTOR_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CONVERSION_SOURCE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CONVERSION_SOURCE_FUTURE_SKEW_MS = 5 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 1000;
const OWNER_LEASE_MS = 60 * 1000;
const OWNER_WRITE_SAFETY_MS = 5 * 1000;
const TARGET = v1.TARGET;
const COLLECTIONS = v1.COLLECTIONS;
const AUDITED_PAID_AMOUNT_FIELD_HASH =
  "7b7ce6ce3b17bc62c7806e505993b4bdf2785cbb05ca7b998d877dd1369b08c6";
const AUDITED_FINANCE_STATUS_FIELD_HASH =
  "c4c1ac9f97345d42ebdd6927516930068256a192b642f2e4fc3a132de70a4691";
const AUDITED_LEGACY_HOUSED_BY_FIELD_HASH =
  "8962d05e641fcb88223e902673ed585d3634c532938d30645cfe64cb54aa14d4";
const EXECUTION_PATHS = Object.freeze([
  "package.json",
  "scripts/repairExpediaCommercialMaterialization20260809.js",
  "scripts/repairExpediaCommercialEnrichment20260809.js",
  "services/recentOtaInboundRecovery20260805.js",
  "services/otaCommercialEvidence.js",
  "services/otaReservationMapper.js",
]);
const MUTATION_CAPABILITIES = new WeakSet();

const clean = (value = "") => String(value?._id || value || "").trim();
const lower = (value = "") => clean(value).toLowerCase();
const upper = (value = "") => clean(value).toUpperCase();
const round2 = (value) => Number(Number(value).toFixed(2));
const sameMoney = (left, right) =>
  Number.isFinite(Number(left)) &&
  Number.isFinite(Number(right)) &&
  Math.abs(round2(left) - round2(right)) < 0.005;
const sameRate = (left, right) =>
  Number.isFinite(Number(left)) &&
  Number.isFinite(Number(right)) &&
  Math.abs(Number(left) - Number(right)) <= 0.0000000001;
const owns = (value, key) =>
  Boolean(value) && Object.prototype.hasOwnProperty.call(value, key);
const hasExactNumericZero = (value, key) =>
  owns(value, key) && Number.isFinite(value[key]) && value[key] === 0;
const dateKey = (value) => {
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime())
    ? parsed.toISOString().slice(0, 10)
    : "";
};
const sha256 = (value) =>
  crypto
    .createHash("sha256")
    .update(String(value || ""), "utf8")
    .digest("hex");

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
        pathText ? pathText + "." + index : String(index),
        output
      )
    );
    return output;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return output;
  for (const [key, entry] of Object.entries(value)) {
    collectNullPaths(entry, pathText ? pathText + "." + key : key, output);
  }
  return output;
}

function buildV2ExactCasFilter(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    fail("Exact CAS requires one BSON document.", "EXPEDIA_V2_CAS_INVALID");
  }
  const rootKeys = Object.keys(document).sort();
  const rootKeyExpression = {
    $expr: {
      $and: [
        {
          $eq: [{ $size: { $objectToArray: "$$ROOT" } }, rootKeys.length],
        },
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
  };
  return {
    $and: [
      cloneBson(document),
      rootKeyExpression,
      ...collectNullPaths(document).map((pathName) => ({
        [pathName]: { $exists: true },
      })),
    ],
  };
}

function fail(message, code = "EXPEDIA_V2_REPAIR_BLOCKED") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function failProtectedDrift({
  kind,
  expectedHash,
  observedHash,
  scopeHash,
  observedReservationHash,
}) {
  const error = new Error(
    "Exact postverification detected an immutable state change."
  );
  error.code = "EXPEDIA_V2_PROTECTED_ARTIFACT_DRIFT";
  error.driftKind = kind;
  error.expectedHash = expectedHash;
  error.observedHash = observedHash || "missing";
  error.scopeHash = scopeHash;
  error.observedReservationHash = observedReservationHash || "missing";
  throw error;
}

function normalizeExecutionAttestation(value, releaseSha) {
  const normalized = {
    releaseSha: lower(value?.releaseSha),
    treeSha: lower(value?.treeSha),
    executionFingerprint: lower(value?.executionFingerprint),
    trackedWorktreeClean: value?.trackedWorktreeClean === true,
  };
  if (
    normalized.releaseSha !== lower(releaseSha) ||
    !/^[a-f0-9]{40}$/.test(normalized.releaseSha) ||
    !/^[a-f0-9]{40}$/.test(normalized.treeSha) ||
    !/^[a-f0-9]{64}$/.test(normalized.executionFingerprint)
  ) {
    fail(
      "The executing checkout attestation is invalid.",
      "EXPEDIA_V2_EXECUTION_ATTESTATION_INVALID"
    );
  }
  return normalized;
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
    const entries = EXECUTION_PATHS.map((filePath) => {
      const line = runGit(["ls-tree", "HEAD", "--", filePath]);
      const match = line.match(/^\d+\s+blob\s+([a-f0-9]{40})\t(.+)$/i);
      if (!match || match[2] !== filePath) {
        fail(
          "A required execution dependency is not tracked in the approved tree.",
          "EXPEDIA_V2_EXECUTION_ATTESTATION_INVALID"
        );
      }
      return { path: filePath, blobSha: lower(match[1]) };
    });
    return normalizeExecutionAttestation(
      {
        releaseSha: observedReleaseSha,
        treeSha,
        executionFingerprint: sha256(
          JSON.stringify({
            releaseSha: observedReleaseSha,
            treeSha,
            entries,
          })
        ),
        trackedWorktreeClean: trackedStatus === "",
      },
      releaseSha
    );
  } catch (error) {
    if (error?.code === "EXPEDIA_V2_EXECUTION_ATTESTATION_INVALID") {
      throw error;
    }
    fail(
      "The executing checkout could not be attested.",
      "EXPEDIA_V2_EXECUTION_ATTESTATION_INVALID"
    );
  }
}

function assertCleanExecution(execution, releaseSha) {
  const normalized = normalizeExecutionAttestation(execution, releaseSha);
  if (normalized.trackedWorktreeClean !== true) {
    fail(
      "A tracked worktree or index change blocks every database write.",
      "EXPEDIA_V2_EXECUTION_DIRTY"
    );
  }
  return normalized;
}

function objectId(value, label = "Mongo id") {
  const textValue = clean(value);
  if (!ObjectId.isValid(textValue)) {
    fail(label + " is invalid.", "EXPEDIA_V2_REPAIR_ID_INVALID");
  }
  return new ObjectId(textValue);
}

function exactDate(value, label) {
  const parsed =
    value instanceof Date ? new Date(value) : new Date(value || "");
  if (!Number.isFinite(parsed.getTime())) {
    fail(label + " is missing or invalid.", "EXPEDIA_V2_EVIDENCE_TIME_INVALID");
  }
  return parsed;
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
      if (apply)
        fail(
          "--apply may be supplied only once.",
          "EXPEDIA_V2_ARGUMENT_INVALID"
        );
      apply = true;
      continue;
    }
    if (argument === "--rollback") {
      if (rollback) {
        fail(
          "--rollback may be supplied only once.",
          "EXPEDIA_V2_ARGUMENT_INVALID"
        );
      }
      rollback = true;
      continue;
    }
    let recognized = false;
    const entries = [
      ["--repair-id=", repairId, (value) => (repairId = value)],
      ["--release-sha=", releaseSha, (value) => (releaseSha = lower(value))],
      ["--proof=", proof, (value) => (proof = lower(value))],
      [
        "--portal-job-id=",
        portalJobId,
        (value) => (portalJobId = lower(value)),
      ],
      [
        "--portal-job-number=",
        portalJobNumber,
        (value) => (portalJobNumber = upper(value)),
      ],
    ];
    for (const [prefix, prior, assign] of entries) {
      if (!argument.startsWith(prefix)) continue;
      if (prior) {
        fail(
          prefix.slice(0, -1) + " may be supplied only once.",
          "EXPEDIA_V2_ARGUMENT_INVALID"
        );
      }
      assign(argument.slice(prefix.length));
      recognized = true;
      break;
    }
    if (!recognized) {
      fail(
        "Unsupported Expedia v2 repair argument.",
        "EXPEDIA_V2_ARGUMENT_INVALID"
      );
    }
  }
  if (!/^[a-f0-9]{40}$/.test(releaseSha)) {
    fail(
      "An exact 40-character --release-sha is required.",
      "EXPEDIA_V2_RELEASE_REQUIRED"
    );
  }
  if (!portalJobId || !portalJobNumber) {
    fail(
      "The fresh portal evidence requires both exact job selectors.",
      "EXPEDIA_V2_PORTAL_SELECTION_REQUIRED"
    );
  }
  if (!/^[a-f0-9]{24}$/.test(portalJobId)) {
    fail(
      "--portal-job-id must be an exact Mongo ObjectId.",
      "EXPEDIA_V2_PORTAL_SELECTION_INVALID"
    );
  }
  if (!/^OTA-RES-SYNC-\d{14}-[A-Z0-9]{5}$/.test(portalJobNumber)) {
    fail(
      "--portal-job-number must be an exact OTA reservation sync job number.",
      "EXPEDIA_V2_PORTAL_SELECTION_INVALID"
    );
  }
  if (apply && repairId !== REPAIR_ID) {
    fail(
      "Apply requires the exact v2 repair ID.",
      "EXPEDIA_V2_REPAIR_ID_REQUIRED"
    );
  }
  if (rollback && repairId !== REPAIR_ID) {
    fail(
      "Rollback requires the exact v2 repair ID.",
      "EXPEDIA_V2_REPAIR_ID_REQUIRED"
    );
  }
  if (!apply && !rollback && (repairId || proof)) {
    fail(
      "--repair-id and --proof are apply-only.",
      "EXPEDIA_V2_ARGUMENT_INVALID"
    );
  }
  if (apply && !/^\d{13}\.[a-f0-9]{64}$/.test(proof)) {
    fail(
      "Apply requires the exact unexpired dry-run proof.",
      "EXPEDIA_V2_PROOF_REQUIRED"
    );
  }
  if (!apply && proof) {
    fail(
      "--proof is accepted only with --apply.",
      "EXPEDIA_V2_ARGUMENT_INVALID"
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

function portalSelectionFromArguments(options = {}) {
  return Object.freeze({
    jobId: lower(options.portalJobId),
    jobNumber: upper(options.portalJobNumber),
  });
}

function parseProof(proof, now = new Date()) {
  const match = lower(proof).match(/^(\d{13})\.([a-f0-9]{64})$/);
  if (!match)
    fail("The dry-run proof format is invalid.", "EXPEDIA_V2_PROOF_INVALID");
  const plannedAtMs = Number(match[1]);
  const nowMs = now.getTime();
  if (
    !Number.isSafeInteger(plannedAtMs) ||
    plannedAtMs > nowMs + CLOCK_SKEW_MS ||
    nowMs - plannedAtMs > PROOF_MAX_AGE_MS
  ) {
    fail(
      "The dry-run proof is expired or from the future.",
      "EXPEDIA_V2_PROOF_EXPIRED"
    );
  }
  return {
    plannedAt: new Date(plannedAtMs),
    expiresAt: new Date(plannedAtMs + PROOF_MAX_AGE_MS),
    planHash: match[2],
  };
}

function proofToken(plan) {
  return (
    new Date(plan.proofIssuedAt || plan.plannedAt).getTime() +
    "." +
    plan.planHash
  );
}

function rollbackProofToken(plan) {
  return proofToken(plan);
}

function createMutationCapability({
  action,
  plan,
  proofDetails,
  execution,
  clock,
}) {
  const capability = {
    action,
    planHash: plan.planHash,
    releaseSha: plan.releaseSha,
    executionFingerprint: execution.executionFingerprint,
    proofIssuedAt: new Date(proofDetails.plannedAt),
    proofExpiresAt: new Date(proofDetails.expiresAt),
    ownerToken: crypto.randomBytes(32).toString("hex"),
    clock,
  };
  MUTATION_CAPABILITIES.add(capability);
  return capability;
}

function assertCapabilityBinding(capability, plan, action) {
  if (
    !capability ||
    !MUTATION_CAPABILITIES.has(capability) ||
    capability.action !== action ||
    capability.planHash !== plan.planHash ||
    capability.releaseSha !== plan.releaseSha ||
    capability.executionFingerprint !== plan.execution.executionFingerprint ||
    typeof capability.clock !== "function"
  ) {
    fail(
      "The mutation boundary lacks an authorized execution capability.",
      "EXPEDIA_V2_WRITE_UNAUTHORIZED"
    );
  }
  return exactDate(capability.clock(), "mutation authorization clock");
}

function assertMutationCapability(capability, plan, action) {
  const now = assertCapabilityBinding(capability, plan, action);
  if (
    now.getTime() < capability.proofIssuedAt.getTime() - CLOCK_SKEW_MS ||
    now.getTime() > capability.proofExpiresAt.getTime()
  ) {
    fail(
      "The dry-run proof expired before the next database mutation.",
      "EXPEDIA_V2_PROOF_EXPIRED"
    );
  }
  return now;
}

function assertCommercialEvidenceFreshAt(plan, now) {
  const finishedAt = exactDate(
    plan?.commercial?.sourceTimestamp,
    "collector completion timestamp"
  );
  const fetchedAt = exactDate(
    plan?.commercial?.conversionFetchedAt,
    "conversion fetch timestamp"
  );
  const sourceAt = exactDate(
    plan?.commercial?.conversion?.provenance?.sourceTimestamp,
    "conversion source timestamp"
  );
  if (
    finishedAt.getTime() > now.getTime() + CLOCK_SKEW_MS ||
    fetchedAt.getTime() > now.getTime() + CLOCK_SKEW_MS ||
    sourceAt.getTime() > now.getTime() + CONVERSION_SOURCE_FUTURE_SKEW_MS ||
    now.getTime() - finishedAt.getTime() > COLLECTOR_MAX_AGE_MS ||
    now.getTime() - fetchedAt.getTime() > COLLECTOR_MAX_AGE_MS ||
    now.getTime() - sourceAt.getTime() > CONVERSION_SOURCE_MAX_AGE_MS
  ) {
    fail(
      "Collector or conversion evidence expired before reservation CAS.",
      "EXPEDIA_V2_EVIDENCE_STALE_AT_WRITE"
    );
  }
  return true;
}

const primaryReadOptions = (session = null) =>
  session
    ? { session }
    : {
        readPreference: "primary",
        readConcern: { level: "majority" },
      };
const majorityWriteOptions = (session = null) =>
  session ? { session } : { writeConcern: { w: "majority" } };

async function findMany(collection, filter, limit = 3, session = null) {
  return collection
    .find(filter, primaryReadOptions(session))
    .limit(limit)
    .toArray();
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
      { "supplierData.suppliedBookingNo": TARGET.otaBookingId },
      { "supplierData.hotelRunner.providerNumber": TARGET.otaBookingId },
    ],
  };
}

function globalProviderIdentityLookup() {
  return {
    $or: [
      { reservation_id: TARGET.otaBookingId },
      { "customer_details.confirmation_number2": TARGET.otaBookingId },
      { otaIdentityKey: TARGET.otaIdentityKey },
      { otaCrossTransportIdentityKey: TARGET.otaIdentityKey },
      { "supplierData.otaConfirmationNumber": TARGET.otaBookingId },
      { "supplierData.platformConfirmationNumber": TARGET.otaBookingId },
      { "supplierData.suppliedBookingNo": TARGET.otaBookingId },
      { "supplierData.hotelRunner.providerNumber": TARGET.otaBookingId },
    ],
  };
}

const expectedIdentityBoundary = () => ({
  hotelPmsReservationIds: [TARGET.reservationMongoId],
  globalPmsReservationIds: [TARGET.reservationMongoId],
  hotelProviderReservationIds: [TARGET.reservationMongoId],
  globalProviderReservationIds: [TARGET.reservationMongoId],
});

const identityIds = (documents) =>
  documents.map((document) => clean(document?._id)).sort();

async function readIdentityBoundary(db, session = null) {
  const reservations = db.collection(COLLECTIONS.reservation);
  const hotelPms = await findMany(
    reservations,
    {
      hotelId: objectId(TARGET.hotelId),
      confirmation_number: TARGET.pmsConfirmationNumber,
    },
    3,
    session
  );
  const globalPms = await findMany(
    reservations,
    { confirmation_number: TARGET.pmsConfirmationNumber },
    3,
    session
  );
  const hotelProvider = await findMany(
    reservations,
    reservationProviderLookup(),
    3,
    session
  );
  const globalProvider = await findMany(
    reservations,
    globalProviderIdentityLookup(),
    3,
    session
  );
  return {
    hotelPmsReservationIds: identityIds(hotelPms),
    globalPmsReservationIds: identityIds(globalPms),
    hotelProviderReservationIds: identityIds(hotelProvider),
    globalProviderReservationIds: identityIds(globalProvider),
  };
}

async function verifyIdentityBoundary({
  db,
  session = null,
  observedReservationHash = "",
  postcommit = false,
}) {
  const expected = expectedIdentityBoundary();
  const observed = await readIdentityBoundary(db, session);
  if (canonicalEjsonSha256(observed) === canonicalEjsonSha256(expected)) {
    return true;
  }
  if (postcommit) {
    failProtectedDrift({
      kind: "identity_uniqueness",
      expectedHash: canonicalEjsonSha256(expected),
      observedHash: canonicalEjsonSha256(observed),
      scopeHash: sha256("expedia-v2:pms-provider-global-identity-boundary"),
      observedReservationHash,
    });
  }
  fail(
    "The exact reservation uniqueness boundary failed.",
    "EXPEDIA_V2_IDENTITY_INVALID"
  );
}

function previewRowReferencesTarget(value, seen = new Set()) {
  if (!value || typeof value !== "object" || value instanceof Date)
    return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const identityFields = new Set([
    "confirmationNumber",
    "matchedLookupValue",
    "reservationId",
    "pmsConfirmationNumber",
    "hotelConfirmationNumber",
    "confirmation_number",
    "confirmation_number2",
    "reservation_id",
    "otaIdentityKey",
    "otaCrossTransportIdentityKey",
    "otaConfirmationNumber",
    "platformConfirmationNumber",
    "suppliedBookingNo",
    "providerNumber",
  ]);
  const identityValues = new Set([
    TARGET.reservationMongoId,
    TARGET.pmsConfirmationNumber,
    TARGET.otaBookingId,
    TARGET.otaIdentityKey,
    TARGET.hotelRunnerReservationId,
    TARGET.hrNumber,
  ]);
  for (const [key, entry] of Object.entries(value)) {
    if (identityFields.has(key) && identityValues.has(clean(entry)))
      return true;
    if (
      entry &&
      typeof entry === "object" &&
      previewRowReferencesTarget(entry, seen)
    ) {
      return true;
    }
  }
  return false;
}

function portalCandidate(job) {
  const buckets = job?.previewBuckets;
  if (!buckets || typeof buckets !== "object" || Array.isArray(buckets)) {
    fail(
      "The selected preview lacks exact bucket evidence.",
      "EXPEDIA_V2_PORTAL_SCOPE_INVALID"
    );
  }
  const primaryBuckets = new Set([
    "newReservations",
    "skippedCancelled",
    "matchedExisting",
    "statusChanged",
    "conflicts",
    "needsReview",
  ]);
  const occurrences = [];
  const paymentOccurrences = [];
  for (const [bucket, rows] of Object.entries(buckets)) {
    if (!Array.isArray(rows)) {
      fail(
        "Every preview bucket must be an exact row array.",
        "EXPEDIA_V2_PORTAL_SCOPE_INVALID"
      );
    }
    rows.forEach((row, index) => {
      if (previewRowReferencesTarget(row)) {
        if (bucket === "paymentOrVccAvailable") {
          paymentOccurrences.push({ bucket, index, row });
        } else {
          occurrences.push({ bucket, index, row });
        }
      }
    });
  }
  if (
    [...primaryBuckets].some((bucket) => !Array.isArray(buckets[bucket])) ||
    occurrences.length !== 1 ||
    occurrences[0]?.bucket !== "matchedExisting" ||
    paymentOccurrences.length !== 1
  ) {
    fail(
      "The target must appear exactly once across primary preview buckets and only as matched-existing.",
      "EXPEDIA_V2_PORTAL_SCOPE_INVALID"
    );
  }
  return {
    candidate: occurrences[0].row,
    paymentAuxiliary: paymentOccurrences[0]?.row || null,
  };
}

function assertPortalEnvelope(job, portalSelection) {
  const allowedFrom = new Set([TARGET.portalDateFrom, TARGET.checkinDate]);
  const allowedTo = new Set([TARGET.checkoutDate, TARGET.portalDateTo]);
  if (
    clean(job?._id) !== portalSelection.jobId ||
    upper(job?.jobNumber) !== portalSelection.jobNumber ||
    lower(job?.provider) !== "expedia" ||
    lower(job?.operation) !== "reservation_sync_preview" ||
    lower(job?.executionMode) !== "supervised_read_only" ||
    lower(job?.status) !== "preview_ready" ||
    lower(job?.collectorState?.status) !== "preview_ready" ||
    job?.collectorState?.readOnly !== true ||
    Number(job?.hotelCount) !== 1 ||
    !allowedFrom.has(clean(job?.dateFrom)) ||
    !allowedTo.has(clean(job?.dateTo)) ||
    !hasExactNumericZero(job?.resultSummary, "appliedWrites")
  ) {
    fail(
      "The supervised read-only Expedia job boundary is invalid.",
      "EXPEDIA_V2_PORTAL_SCOPE_INVALID"
    );
  }
  const targetHotels = Array.isArray(job?.targetHotels) ? job.targetHotels : [];
  const selectedIds = Array.isArray(job?.collectorState?.selectedHotelIds)
    ? job.collectorState.selectedHotelIds.map(clean)
    : [];
  if (
    targetHotels.length !== 1 ||
    clean(targetHotels[0]?.hotelId) !== TARGET.hotelId ||
    selectedIds.length !== 1 ||
    selectedIds[0] !== TARGET.hotelId ||
    Number(job?.collectorState?.selectedHotelCount) !== 1
  ) {
    fail(
      "The preview job is not confined to the one audited hotel.",
      "EXPEDIA_V2_PORTAL_SCOPE_INVALID"
    );
  }
  const finished = (Array.isArray(job?.auditLog) ? job.auditLog : []).filter(
    (entry) =>
      clean(entry?.action) === "collector_finished" && entry?.readOnly === true
  );
  if (finished.length !== 1) {
    fail(
      "The preview job lacks one exact read-only completion audit.",
      "EXPEDIA_V2_PORTAL_SCOPE_INVALID"
    );
  }
  return { ...portalCandidate(job), finishedAudit: finished[0] };
}

function assertTrustedConversion(value = {}) {
  const exactKeys = (candidate, allowed) => {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate) ||
      Object.getPrototypeOf(candidate) !== Object.prototype ||
      Object.getOwnPropertySymbols(candidate).length !== 0 ||
      Object.keys(candidate).sort().join("\u0000") !==
        [...allowed].sort().join("\u0000") ||
      Object.values(Object.getOwnPropertyDescriptors(candidate)).some(
        (descriptor) =>
          !("value" in descriptor) ||
          descriptor.enumerable !== true ||
          descriptor.configurable !== true ||
          descriptor.writable !== true
      )
    ) {
      fail(
        "The stored conversion evidence contains an unexpected shape.",
        "EXPEDIA_V2_CONVERSION_UNTRUSTED"
      );
    }
  };
  exactKeys(value, [
    "trusted",
    "verified",
    "sourceCurrency",
    "propertyCurrency",
    "rate",
    "provenance",
  ]);
  const provenance = value.provenance;
  exactKeys(provenance, [
    "provider",
    "sourceType",
    "sourceHash",
    "sourceTimestamp",
    "sourceId",
  ]);
  const sourceHash = lower(provenance.sourceHash);
  const sourceId = lower(provenance.sourceId);
  const rate = Number(value?.rate);
  const sourceTimestamp = exactDate(
    provenance.sourceTimestamp,
    "conversion provenance timestamp"
  );
  const normalizedRate = Number(rate.toFixed(10));
  const expectedTuple = {
    provider: "exchange_rate_api",
    sourceType: "trusted_exchange_evidence",
    sourceCurrency: TARGET.sourceCurrency,
    propertyCurrency: TARGET.propertyCurrency,
    rate: normalizedRate,
    sourceTimestamp: sourceTimestamp.toISOString(),
  };
  const expectedHash = sha256(JSON.stringify(expectedTuple));
  const expectedId = "exchange-rate-api-usd-sar-" + expectedHash.slice(0, 24);
  if (
    value?.trusted !== true ||
    value?.verified !== true ||
    upper(value?.sourceCurrency) !== TARGET.sourceCurrency ||
    upper(value?.propertyCurrency) !== TARGET.propertyCurrency ||
    !Number.isFinite(rate) ||
    rate <= 0 ||
    rate > 1_000_000 ||
    lower(provenance.provider) !== "exchange_rate_api" ||
    lower(provenance.sourceType) !== "trusted_exchange_evidence" ||
    sourceHash !== expectedHash ||
    sourceId !== expectedId
  ) {
    fail(
      "The stored currency conversion evidence is not the trusted exact contract.",
      "EXPEDIA_V2_CONVERSION_UNTRUSTED"
    );
  }
  return {
    trusted: true,
    verified: true,
    sourceCurrency: TARGET.sourceCurrency,
    propertyCurrency: TARGET.propertyCurrency,
    rate: normalizedRate,
    provenance: {
      provider: "exchange_rate_api",
      sourceType: "trusted_exchange_evidence",
      sourceHash,
      sourceTimestamp: sourceTimestamp.toISOString(),
      sourceId,
    },
  };
}

function assertProducerReleaseAttestation(job, execution) {
  const attestation = job?.collectorPlan?.producerReleaseAttestation;
  const allowedKeys = [
    "schemaVersion",
    "source",
    "releaseSha",
    "treeSha",
    "trackedWorktreeClean",
    "evidenceEligible",
    "status",
    "capturedAt",
  ];
  if (
    !attestation ||
    typeof attestation !== "object" ||
    Array.isArray(attestation) ||
    Object.keys(attestation).sort().join("\u0000") !==
      allowedKeys.sort().join("\u0000") ||
    attestation.schemaVersion !== 1 ||
    attestation.source !== "git" ||
    attestation.releaseSha !== execution.releaseSha ||
    attestation.treeSha !== execution.treeSha ||
    attestation.trackedWorktreeClean !== true ||
    attestation.evidenceEligible !== true ||
    attestation.status !== "verified_clean"
  ) {
    fail(
      "The collector job was not produced by the exact approved clean release.",
      "EXPEDIA_V2_PRODUCER_ATTESTATION_INVALID"
    );
  }
  const capturedAt = exactDate(
    attestation.capturedAt,
    "collector producer attestation timestamp"
  );
  const createdAt = exactDate(job?.createdAt, "collector creation timestamp");
  const expectedHash = canonicalEjsonSha256(attestation);
  const actionEntries = new Map();
  for (const action of [
    "collector_queued",
    "collector_started",
    "collector_finished",
  ]) {
    const matches = (Array.isArray(job?.auditLog) ? job.auditLog : []).filter(
      (entry) => entry?.action === action
    );
    if (
      matches.length !== 1 ||
      matches[0]?.readOnly !== true ||
      canonicalEjsonSha256(matches[0]?.producerReleaseAttestation) !==
        expectedHash
    ) {
      fail(
        "The collector audit does not preserve one exact producer attestation.",
        "EXPEDIA_V2_PRODUCER_ATTESTATION_INVALID"
      );
    }
    actionEntries.set(action, matches[0]);
  }
  const queuedAt = exactDate(
    actionEntries.get("collector_queued")?.at,
    "collector queued audit timestamp"
  );
  const startedAt = exactDate(
    actionEntries.get("collector_started")?.at,
    "collector started audit timestamp"
  );
  const finishedAt = exactDate(
    actionEntries.get("collector_finished")?.at,
    "collector finished audit timestamp"
  );
  if (
    capturedAt.getTime() > createdAt.getTime() ||
    createdAt.getTime() > queuedAt.getTime() ||
    queuedAt.getTime() > startedAt.getTime() ||
    startedAt.getTime() > finishedAt.getTime()
  ) {
    fail(
      "The collector producer attestation chronology is invalid.",
      "EXPEDIA_V2_PRODUCER_ATTESTATION_INVALID"
    );
  }
  return cloneBson(attestation);
}

function assertFreshPortalEvidence({
  job,
  portalSelection,
  lineage,
  plannedAt,
  execution,
  requireFresh = true,
}) {
  assertProducerReleaseAttestation(job, execution);
  const { candidate, paymentAuxiliary, finishedAudit } = assertPortalEnvelope(
    job,
    portalSelection
  );
  const summary = candidate?.paymentSummary || {};
  const conversion = assertTrustedConversion(
    candidate?.currencyConversionEvidence
  );
  const gross = round2(TARGET.portalGuestGross * conversion.rate);
  const payout = round2(TARGET.hotelRunnerReportedAmount * conversion.rate);
  const createdAt = exactDate(job?.createdAt, "collector creation timestamp");
  const finishedAt = exactDate(
    job?.collectorState?.finishedAt || job?.updatedAt,
    "collector completion timestamp"
  );
  const auditAt = exactDate(
    finishedAudit?.at,
    "collector completion audit timestamp"
  );
  const conversionSourceAt = exactDate(
    conversion.provenance.sourceTimestamp,
    "conversion source timestamp"
  );
  const conversionFetchedAt = exactDate(
    candidate?.amountConvertedAt,
    "candidate conversion fetch timestamp"
  );
  const summaryConversionFetchedAt = exactDate(
    summary?.amountConvertedAt,
    "summary conversion fetch timestamp"
  );
  const v1AppliedAt = exactDate(
    lineage?.manifest?.appliedAt,
    "v1 applied timestamp"
  );
  const planTime = exactDate(plannedAt, "repair plan timestamp");
  if (
    clean(candidate?.hotelId) !== TARGET.hotelId ||
    clean(candidate?.confirmationNumber) !== TARGET.otaBookingId ||
    clean(candidate?.reservationId) !== TARGET.reservationMongoId ||
    clean(candidate?.pmsConfirmationNumber) !== TARGET.pmsConfirmationNumber ||
    clean(candidate?.matchedLookupValue) !== TARGET.otaBookingId ||
    clean(candidate?.actionPreview) !== "matched_existing_no_write" ||
    dateKey(candidate?.checkinDate) !== TARGET.checkinDate ||
    dateKey(candidate?.checkoutDate) !== TARGET.checkoutDate ||
    lower(candidate?.paymentCollectionModel) !== "expedia_collect" ||
    candidate?.detailsFetched !== true ||
    candidate?.detailCommercialEvidence?.guestGrossExplicit !== true ||
    candidate?.detailCommercialEvidence?.hotelPayoutExplicit !== true ||
    upper(candidate?.detailCommercialEvidence?.sourceCurrency) !==
      TARGET.sourceCurrency ||
    candidate?.requiresManualReview === true ||
    candidate?.commercialEvidenceConflict !== false ||
    !Array.isArray(candidate?.commercialEvidenceConflicts) ||
    candidate.commercialEvidenceConflicts.length !== 0 ||
    clean(candidate?.fxConversionError) ||
    upper(candidate?.sourceCurrency) !== TARGET.sourceCurrency ||
    upper(summary?.sourceCurrency) !== TARGET.sourceCurrency ||
    !sameMoney(candidate?.sourceAmount, TARGET.portalGuestGross) ||
    !sameMoney(
      summary?.sourceTotalGuestPaymentAmount,
      TARGET.portalGuestGross
    ) ||
    !sameMoney(
      summary?.sourceTotalPayoutAmount,
      TARGET.hotelRunnerReportedAmount
    ) ||
    !sameMoney(
      candidate?.sourcePayoutAmount,
      TARGET.hotelRunnerReportedAmount
    ) ||
    upper(candidate?.sourcePayoutCurrency) !== TARGET.sourceCurrency ||
    upper(summary?.sourceTotalPayoutCurrency) !== TARGET.sourceCurrency ||
    candidate?.propertyConversionVerified !== true ||
    summary?.propertyConversionVerified !== true ||
    upper(candidate?.propertyCurrency) !== TARGET.propertyCurrency ||
    upper(summary?.propertyCurrency) !== TARGET.propertyCurrency ||
    upper(candidate?.currency) !== TARGET.propertyCurrency ||
    upper(summary?.currency) !== TARGET.propertyCurrency ||
    !sameMoney(candidate?.totalAmountSar, gross) ||
    !sameMoney(candidate?.amount, gross) ||
    !sameMoney(summary?.totalGuestPaymentAmount, gross) ||
    !sameMoney(summary?.totalPayoutAmount, payout) ||
    !sameMoney(candidate?.totalPayoutSar, payout) ||
    !sameMoney(candidate?.netAfterExpensesTotal, payout) ||
    !sameRate(candidate?.exchangeRateToSar, conversion.rate) ||
    !sameRate(summary?.exchangeRateToSar, conversion.rate) ||
    ![
      "exchange_rate_api",
      "exchange_rate_api_cached",
      "exchange_rate_api_stored",
    ].includes(lower(candidate?.exchangeRateSource)) ||
    ![
      "exchange_rate_api",
      "exchange_rate_api_cached",
      "exchange_rate_api_stored",
    ].includes(lower(summary?.exchangeRateSource))
  ) {
    fail(
      "The portal row does not reconcile the exact authenticated USD gross and payout.",
      "EXPEDIA_V2_PORTAL_MONEY_INVALID"
    );
  }
  if (conversionFetchedAt.getTime() !== summaryConversionFetchedAt.getTime()) {
    fail(
      "The materialized portal amounts do not share one conversion fetch.",
      "EXPEDIA_V2_CONVERSION_UNTRUSTED"
    );
  }
  if (
    paymentAuxiliary &&
    (clean(paymentAuxiliary?.hotelId) !== TARGET.hotelId ||
      clean(paymentAuxiliary?.confirmationNumber) !== TARGET.otaBookingId ||
      clean(paymentAuxiliary?.reservationId) !== TARGET.reservationMongoId ||
      clean(paymentAuxiliary?.actionPreview) !==
        "payment_signal_no_card_data_stored" ||
      lower(paymentAuxiliary?.paymentCollectionModel) !== "expedia_collect" ||
      upper(paymentAuxiliary?.sourceCurrency) !== TARGET.sourceCurrency ||
      upper(paymentAuxiliary?.sourceTotalPayoutCurrency) !==
        TARGET.sourceCurrency ||
      upper(paymentAuxiliary?.propertyCurrency) !== TARGET.propertyCurrency ||
      upper(paymentAuxiliary?.currency) !== TARGET.propertyCurrency ||
      paymentAuxiliary?.propertyConversionVerified !== true ||
      !sameMoney(paymentAuxiliary?.sourceAmount, TARGET.portalGuestGross) ||
      !sameMoney(
        paymentAuxiliary?.sourceTotalGuestPaymentAmount,
        TARGET.portalGuestGross
      ) ||
      !sameMoney(
        paymentAuxiliary?.sourceTotalPayoutAmount,
        TARGET.hotelRunnerReportedAmount
      ) ||
      !sameMoney(paymentAuxiliary?.totalGuestPaymentAmount, gross) ||
      !sameMoney(paymentAuxiliary?.totalPayoutAmount, payout) ||
      !sameRate(paymentAuxiliary?.exchangeRateToSar, conversion.rate) ||
      lower(paymentAuxiliary?.exchangeRateSource) !==
        lower(candidate?.exchangeRateSource) ||
      exactDate(
        paymentAuxiliary?.amountConvertedAt,
        "auxiliary conversion fetch timestamp"
      ).getTime() !== conversionFetchedAt.getTime() ||
      canonicalEjsonSha256(paymentAuxiliary?.currencyConversionEvidence) !==
        canonicalEjsonSha256(candidate?.currencyConversionEvidence))
  ) {
    fail(
      "The auxiliary payment row does not reconcile the exact matched target.",
      "EXPEDIA_V2_PORTAL_MONEY_INVALID"
    );
  }
  for (const value of [
    candidate?.explicitOtaCommission,
    summary?.explicitOtaCommission,
  ]) {
    if (value !== null && value !== undefined) {
      fail(
        "An explicit OTA commission appeared and requires a new plan.",
        "EXPEDIA_V2_COMMISSION_CONFLICT"
      );
    }
  }
  if (
    finishedAt.getTime() < createdAt.getTime() ||
    auditAt.getTime() < finishedAt.getTime() ||
    auditAt.getTime() > finishedAt.getTime() + CLOCK_SKEW_MS ||
    createdAt.getTime() - conversionFetchedAt.getTime() >
      COLLECTOR_MAX_AGE_MS ||
    conversionFetchedAt.getTime() > finishedAt.getTime() + CLOCK_SKEW_MS ||
    conversionSourceAt.getTime() >
      conversionFetchedAt.getTime() + CONVERSION_SOURCE_FUTURE_SKEW_MS ||
    conversionFetchedAt.getTime() - conversionSourceAt.getTime() >
      CONVERSION_SOURCE_MAX_AGE_MS
  ) {
    fail(
      "The portal or conversion evidence chronology is invalid.",
      "EXPEDIA_V2_EVIDENCE_TIME_INVALID"
    );
  }
  if (
    requireFresh &&
    (createdAt.getTime() <= v1AppliedAt.getTime() ||
      portalSelection.jobId === clean(lineage?.manifest?.portalJobId) ||
      finishedAt.getTime() > planTime.getTime() + CLOCK_SKEW_MS ||
      planTime.getTime() - finishedAt.getTime() > COLLECTOR_MAX_AGE_MS ||
      planTime.getTime() - conversionFetchedAt.getTime() > COLLECTOR_MAX_AGE_MS)
  ) {
    fail(
      "The selected collector evidence is not fresh after v1.",
      "EXPEDIA_V2_EVIDENCE_STALE"
    );
  }
  return {
    candidate,
    conversion,
    gross,
    payout,
    deduction: round2(gross - payout),
    sourceDeduction: round2(
      TARGET.portalGuestGross - TARGET.hotelRunnerReportedAmount
    ),
    sourceTimestamp: finishedAt,
    conversionFetchedAt,
  };
}

async function loadV1Lineage(db) {
  const manifest = await db
    .collection(v1.MANIFEST_COLLECTION)
    .findOne({ _id: v1.REPAIR_ID }, primaryReadOptions());
  if (
    !manifest ||
    clean(manifest.repairId) !== v1.REPAIR_ID ||
    manifest.state !== "applied" ||
    manifest.backupCollection !== v1.BACKUP_COLLECTION ||
    Number(manifest.backupRecordCount) !== 4 ||
    !/^[a-f0-9]{40}$/.test(lower(manifest.releaseSha)) ||
    !/^[a-f0-9]{64}$/.test(lower(manifest.planHash)) ||
    !/^[a-f0-9]{64}$/.test(lower(manifest.originalHash)) ||
    !/^[a-f0-9]{64}$/.test(lower(manifest.expectedRepairedHash)) ||
    !/^[a-f0-9]{64}$/.test(lower(manifest.evidenceHash)) ||
    !/^[a-f0-9]{64}$/.test(lower(manifest.backupSetSha256)) ||
    manifest.appliedDocumentHash !== manifest.expectedRepairedHash ||
    !hasExactNumericZero(manifest, "vendorApiCalls")
  ) {
    fail(
      "The immutable v1 repair is not in its exact applied state.",
      "EXPEDIA_V2_V1_LINEAGE_INVALID"
    );
  }
  const predecessorSelection = {
    jobId: clean(manifest.portalJobId),
    jobNumber: clean(manifest.portalJobNumber),
  };
  const backup = await v1.loadAndVerifyBackup(db, predecessorSelection);
  const reservationRecord = backup.byRole.get("reservation_before");
  const eventRecord = backup.byRole.get("hotelrunner_event_evidence");
  const mirrorRecord = backup.byRole.get("hotelrunner_mirror_evidence");
  const portalRecord = backup.byRole.get("expedia_portal_job_evidence");
  if (
    !reservationRecord ||
    !eventRecord ||
    !mirrorRecord ||
    !portalRecord ||
    reservationRecord.sourceCollection !== COLLECTIONS.reservation ||
    eventRecord.sourceCollection !== COLLECTIONS.event ||
    mirrorRecord.sourceCollection !== COLLECTIONS.mirror ||
    portalRecord.sourceCollection !== COLLECTIONS.portalJob ||
    clean(reservationRecord.documentId) !== TARGET.reservationMongoId ||
    clean(eventRecord.documentId) !== TARGET.eventId ||
    clean(mirrorRecord.documentId) !== TARGET.mirrorId ||
    reservationRecord.expectedRepairedHash !== manifest.expectedRepairedHash ||
    reservationRecord.originalHash !== manifest.originalHash ||
    backup.backupSetSha256 !== manifest.backupSetSha256
  ) {
    fail(
      "The v1 manifest and immutable backup lineage diverged.",
      "EXPEDIA_V2_V1_LINEAGE_INVALID"
    );
  }
  v1.assertPreRepairCommercialState(reservationRecord.originalDocument);
  v1.assertHotelRunnerEnvelope(
    eventRecord.originalDocument,
    mirrorRecord.originalDocument
  );
  v1.assertPortalJob(portalRecord.originalDocument, predecessorSelection);
  const [liveEvent, liveMirror, livePortalJob] = await Promise.all([
    db
      .collection(COLLECTIONS.event)
      .findOne({ _id: objectId(TARGET.eventId) }, primaryReadOptions()),
    db
      .collection(COLLECTIONS.mirror)
      .findOne({ _id: objectId(TARGET.mirrorId) }, primaryReadOptions()),
    db
      .collection(COLLECTIONS.portalJob)
      .findOne(
        { _id: objectId(predecessorSelection.jobId) },
        primaryReadOptions()
      ),
  ]);
  if (
    !liveEvent ||
    !liveMirror ||
    !livePortalJob ||
    canonicalEjsonSha256(liveEvent) !== eventRecord.originalHash ||
    canonicalEjsonSha256(liveMirror) !== mirrorRecord.originalHash ||
    canonicalEjsonSha256(livePortalJob) !== portalRecord.originalHash
  ) {
    fail(
      "Live v1 evidence no longer equals its immutable archive.",
      "EXPEDIA_V2_V1_LINEAGE_INVALID"
    );
  }
  const rebuilt = v1.buildExpectedDocument({
    reservation: reservationRecord.originalDocument,
    event: eventRecord.originalDocument,
    job: portalRecord.originalDocument,
    releaseSha: manifest.releaseSha,
    repairAt: manifest.proofPlannedAt,
    portalSelection: predecessorSelection,
  });
  if (
    canonicalEjsonSha256(rebuilt.expectedDocument) !==
      manifest.expectedRepairedHash ||
    rebuilt.evidence.evidenceHash !== manifest.evidenceHash
  ) {
    fail(
      "The v1 post-state cannot be reconstructed from its immutable proof.",
      "EXPEDIA_V2_V1_LINEAGE_INVALID"
    );
  }
  return {
    manifest,
    manifestHash: canonicalEjsonSha256(manifest),
    backup,
    expectedDocument: rebuilt.expectedDocument,
    expectedHash: manifest.expectedRepairedHash,
    predecessorSelection,
  };
}

async function loadRawScope(db, portalSelection) {
  const reservations = db.collection(COLLECTIONS.reservation);
  const [
    reservation,
    pmsMatches,
    globalPmsMatches,
    providerMatches,
    globalProviderMatches,
    event,
    mirror,
    job,
  ] = await Promise.all([
    reservations.findOne(
      { _id: objectId(TARGET.reservationMongoId) },
      primaryReadOptions()
    ),
    findMany(
      reservations,
      {
        hotelId: objectId(TARGET.hotelId),
        confirmation_number: TARGET.pmsConfirmationNumber,
      },
      3
    ),
    findMany(
      reservations,
      { confirmation_number: TARGET.pmsConfirmationNumber },
      3
    ),
    findMany(reservations, reservationProviderLookup(), 3),
    findMany(reservations, globalProviderIdentityLookup(), 3),
    db
      .collection(COLLECTIONS.event)
      .findOne({ _id: objectId(TARGET.eventId) }, primaryReadOptions()),
    db
      .collection(COLLECTIONS.mirror)
      .findOne({ _id: objectId(TARGET.mirrorId) }, primaryReadOptions()),
    db
      .collection(COLLECTIONS.portalJob)
      .findOne({ _id: objectId(portalSelection.jobId) }, primaryReadOptions()),
  ]);
  if (
    !reservation ||
    pmsMatches.length !== 1 ||
    globalPmsMatches.length !== 1 ||
    providerMatches.length !== 1 ||
    globalProviderMatches.length !== 1
  ) {
    fail(
      "The exact reservation uniqueness boundary failed.",
      "EXPEDIA_V2_IDENTITY_INVALID"
    );
  }
  if (
    clean(pmsMatches[0]?._id) !== TARGET.reservationMongoId ||
    clean(globalPmsMatches[0]?._id) !== TARGET.reservationMongoId ||
    clean(providerMatches[0]?._id) !== TARGET.reservationMongoId ||
    clean(globalProviderMatches[0]?._id) !== TARGET.reservationMongoId
  ) {
    fail(
      "PMS and provider identities do not converge.",
      "EXPEDIA_V2_IDENTITY_INVALID"
    );
  }
  v1.assertHotelRunnerEnvelope(event, mirror);
  assertPortalEnvelope(job, portalSelection);
  return { reservation, event, mirror, job };
}

function assertPredecessorLiveEvidence(scope, lineage) {
  const eventRecord = lineage.backup.byRole.get("hotelrunner_event_evidence");
  const mirrorRecord = lineage.backup.byRole.get("hotelrunner_mirror_evidence");
  if (
    canonicalEjsonSha256(scope.event) !== eventRecord.originalHash ||
    canonicalEjsonSha256(scope.mirror) !== mirrorRecord.originalHash
  ) {
    fail(
      "Live HotelRunner evidence no longer equals the immutable v1 archive.",
      "EXPEDIA_V2_V1_LINEAGE_INVALID"
    );
  }
}

function assertOperationallySafe(reservation, expectedV1Document) {
  const state = lower(reservation?.state);
  const reservationStatus = lower(reservation?.reservation_status);
  const terminal =
    /cancel|no.?show|inhouse|in.house|housed|check.?in|check.?out|complete/;
  if (
    terminal.test(state) ||
    terminal.test(reservationStatus) ||
    state !== lower(expectedV1Document?.state) ||
    reservationStatus !== lower(expectedV1Document?.reservation_status)
  ) {
    fail("Lifecycle changed or is terminal.", "EXPEDIA_V2_PROTECTED_STATE");
  }
  const canonicalField = (document, key) => ({
    present: owns(document, key),
    value: owns(document, key) ? document[key] : null,
  });
  const canonicalFieldHash = (document, key) =>
    canonicalEjsonSha256(canonicalField(document, key));
  const paidAmountFieldHash = canonicalFieldHash(
    expectedV1Document,
    "paid_amount"
  );
  const financeStatusFieldHash = canonicalFieldHash(
    expectedV1Document,
    "financeStatus"
  );
  const housedByFieldHash = canonicalFieldHash(expectedV1Document, "housedBy");
  const expectedPaidAmountIsInactive =
    !owns(expectedV1Document, "paid_amount") ||
    hasExactNumericZero(expectedV1Document, "paid_amount");
  const expectedFinanceStatus = lower(expectedV1Document?.financeStatus);
  const inactivePaymentBaseline =
    expectedPaidAmountIsInactive &&
    ["", "not paid", "unpaid", "pending"].includes(expectedFinanceStatus);
  const auditedPaidOnlineBaseline =
    paidAmountFieldHash === AUDITED_PAID_AMOUNT_FIELD_HASH &&
    financeStatusFieldHash === AUDITED_FINANCE_STATUS_FIELD_HASH;
  const expectedHousedBy = expectedV1Document?.housedBy;
  const expectedHousedByPrototype =
    expectedHousedBy && typeof expectedHousedBy === "object"
      ? Object.getPrototypeOf(expectedHousedBy)
      : null;
  const inactiveHousedByBaseline =
    !owns(expectedV1Document, "housedBy") ||
    expectedHousedBy == null ||
    expectedHousedBy === false ||
    expectedHousedBy === 0 ||
    expectedHousedBy === "" ||
    (Array.isArray(expectedHousedBy) && expectedHousedBy.length === 0) ||
    (typeof expectedHousedBy === "object" &&
      !Array.isArray(expectedHousedBy) &&
      (expectedHousedByPrototype === Object.prototype ||
        expectedHousedByPrototype === null) &&
      Object.keys(expectedHousedBy).length === 0);
  const auditedLegacyHousedByBaseline =
    housedByFieldHash === AUDITED_LEGACY_HOUSED_BY_FIELD_HASH;
  if (
    canonicalFieldHash(reservation, "paid_amount") !== paidAmountFieldHash ||
    canonicalFieldHash(reservation, "financeStatus") !==
      financeStatusFieldHash ||
    canonicalFieldHash(reservation, "housedBy") !== housedByFieldHash ||
    (!inactivePaymentBaseline && !auditedPaidOnlineBaseline) ||
    (!inactiveHousedByBaseline && !auditedLegacyHousedByBaseline)
  ) {
    fail(
      "Audited payment or legacy housing baseline changed.",
      "EXPEDIA_V2_PROTECTED_STATE"
    );
  }
  const meaningful = (value) => {
    if (value == null || value === false || value === 0 || value === "")
      return false;
    if (value instanceof Date) return true;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "object") {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return true;
      return Object.keys(value).length > 0;
    }
    return true;
  };
  if (
    meaningful(reservation?.roomId) ||
    meaningful(reservation?.bedNumber) ||
    [
      reservation?.housed,
      reservation?.isHoused,
      reservation?.housedAt,
      reservation?.inhouse_date,
      reservation?.checkedInAt,
      reservation?.checkedOutAt,
    ].some(meaningful)
  ) {
    fail(
      "Housing or room assignment activity blocks repair.",
      "EXPEDIA_V2_PROTECTED_STATE"
    );
  }
  if (
    hasCaptureOrSettlementActivity(reservation) ||
    reservation?.moneyTransferredToHotel === true ||
    reservation?.commissionPaid === true ||
    reservation?.payment_details?.captured === true ||
    Math.abs(Number(reservation?.payment_details?.onsite_paid_amount || 0)) >
      0.0001 ||
    [
      reservation?.payment_details?.captureId,
      reservation?.payment_details?.transactionId,
      reservation?.payment_details?.settlementId,
      reservation?.payment_details?.finalCaptureTransactionId,
      reservation?.financial_cycle?.capturedAt,
      reservation?.financial_cycle?.settledAt,
      reservation?.financial_cycle?.paidAt,
      reservation?.financial_cycle?.hotelPaidAt,
      reservation?.financial_cycle?.closedAt,
      reservation?.financial_cycle?.closedBy,
      reservation?.financial_cycle?.captureId,
      reservation?.financial_cycle?.settlementId,
      reservation?.bofa_payment?.vcc?.chargedAt,
      reservation?.bofa_payment?.vcc?.captureId,
      reservation?.bofa_payment?.vcc?.transactionId,
    ].some(meaningful) ||
    ["paid", "captured", "settled", "complete", "completed"].includes(
      lower(reservation?.financial_cycle?.status)
    ) ||
    reservation?.bofa_payment?.vcc?.charged === true
  ) {
    fail(
      "Capture or settlement activity blocks repair.",
      "EXPEDIA_V2_PROTECTED_STATE"
    );
  }
  const review = reservation?.otaPlatformReview || {};
  const admin = reservation?.adminPricing || {};
  if (
    meaningful(reservation?.orderTakeId) ||
    meaningful(reservation?.adminChangeLog) ||
    meaningful(reservation?.financeRejectionComment) ||
    meaningful(reservation?.totalReviewStatus) ||
    [
      review.releasedAt,
      review.releasedBy,
      review.closedAt,
      review.closedBy,
      review.lastPricingUpdatedAt,
      review.pricingInvalidatedAt,
      reservation?.adminPricingVisibility?.appliedBy,
    ].some(meaningful) ||
    ["released", "closed", "approved", "rejected"].includes(
      lower(review.status)
    ) ||
    /manual|employee|admin/.test(
      (clean(admin.mode) + " " + clean(admin.source)).toLowerCase()
    ) ||
    Object.keys(admin).some((key) =>
      key.toLowerCase().startsWith("clienttotaloverride")
    )
  ) {
    fail(
      "Manual or released state blocks repair.",
      "EXPEDIA_V2_PROTECTED_STATE"
    );
  }
}

function assertExactV1PostState(reservation, lineage) {
  assertOperationallySafe(reservation, lineage.expectedDocument);
  if (
    canonicalEjsonSha256(reservation) !== lineage.expectedHash ||
    Number(reservation?.__v) !== TARGET.reservationVersion + 1 ||
    clean(reservation?.supplierData?.otaCommercialRepair?.repairId) !==
      v1.REPAIR_ID ||
    reservation?.total_amount !== null ||
    reservation?.adminPricing?.clientTotal !== null ||
    reservation?.adminPricing?.netAfterExpensesTotal !== null ||
    reservation?.ota_financial_summary?.clientTotal !== null ||
    reservation?.ota_financial_summary?.netAfterExpenses !== null ||
    reservation?.supplierData?.otaAmountSar !== null ||
    reservation?.supplierData?.otaTotalPayoutSar !== null ||
    reservation?.supplierData?.otaExpenseTotalSar !== null ||
    reservation?.supplierData?.otaCommercialEvidence?.currencyConversion !==
      null ||
    reservation?.supplierData?.otaCommercialEvidence?.roles?.guestGross
      ?.propertyAmount !== null ||
    reservation?.supplierData?.otaCommercialEvidence?.roles?.hotelPayout
      ?.propertyAmount !== null
  ) {
    fail(
      "The reservation is not the exact immutable v1 source-only post-state.",
      "EXPEDIA_V2_V1_POST_STATE_INVALID"
    );
  }
}

function sourceSlots(reservation = {}) {
  const rooms = Array.isArray(reservation?.pickedRoomsPricing)
    ? reservation.pickedRoomsPricing
    : [];
  const mirrored = Array.isArray(reservation?.pickedRoomsType)
    ? reservation.pickedRoomsType
    : [];
  if (
    rooms.length !== 1 ||
    mirrored.length !== 1 ||
    canonicalEjsonSha256(rooms) !== canonicalEjsonSha256(mirrored)
  ) {
    fail(
      "The two one-room pricing projections diverged.",
      "EXPEDIA_V2_ALLOCATION_INVALID"
    );
  }
  const days = Array.isArray(rooms[0]?.pricingByDay)
    ? rooms[0].pricingByDay
    : [];
  const rawNights = (
    Array.isArray(reservation?.supplierData?.hotelRunner?.pricing?.rooms)
      ? reservation.supplierData.hotelRunner.pricing.rooms
      : []
  ).flatMap((room) => (Array.isArray(room?.nightly) ? room.nightly : []));
  if (days.length !== TARGET.nights || rawNights.length !== TARGET.nights) {
    fail(
      "The exact six-night source allocation boundary changed.",
      "EXPEDIA_V2_ALLOCATION_INVALID"
    );
  }
  const rawByDate = new Map();
  for (const row of rawNights) {
    const key = dateKey(row?.date);
    if (!key || rawByDate.has(key)) {
      fail(
        "HotelRunner source nights are missing or duplicated.",
        "EXPEDIA_V2_ALLOCATION_INVALID"
      );
    }
    rawByDate.set(key, Number(row?.finalPrice));
  }
  const slots = days.map((day, index) => {
    const expectedDate = new Date(TARGET.checkinDate + "T00:00:00.000Z");
    expectedDate.setUTCDate(expectedDate.getUTCDate() + index);
    const key = dateKey(day?.date);
    const sourceWeight = Number(day?.hotelRunnerSourcePrice);
    const rawWeight = rawByDate.get(key);
    const rootWeight = Number(day?.rootPrice);
    if (
      key !== expectedDate.toISOString().slice(0, 10) ||
      !Number.isFinite(sourceWeight) ||
      sourceWeight <= 0 ||
      !Number.isFinite(rawWeight) ||
      rawWeight <= 0 ||
      !sameMoney(sourceWeight, rawWeight) ||
      !Number.isFinite(rootWeight) ||
      rootWeight < 0 ||
      !sameMoney(rootWeight, TARGET.dailyRoot[index])
    ) {
      fail(
        "A stored source/root allocation weight is invalid.",
        "EXPEDIA_V2_ALLOCATION_INVALID"
      );
    }
    return {
      roomIndex: 0,
      dayIndex: index,
      date: key,
      sourceWeight,
      rootWeight,
    };
  });
  if (
    !sameMoney(
      slots.reduce((sum, slot) => sum + slot.sourceWeight, 0),
      TARGET.hotelRunnerReportedAmount
    ) ||
    !sameMoney(
      slots.reduce((sum, slot) => sum + slot.rootWeight, 0),
      TARGET.rootTotal
    )
  ) {
    fail(
      "Stored source/root weights do not reconcile to exact totals.",
      "EXPEDIA_V2_ALLOCATION_INVALID"
    );
  }
  return slots;
}

function allocateCentsByWeight(totalAmount, weights = []) {
  const totalCents = Math.round(Number(totalAmount) * 100);
  const safeWeights = weights.map(Number);
  if (
    !Number.isSafeInteger(totalCents) ||
    totalCents < 0 ||
    !safeWeights.length ||
    safeWeights.some((weight) => !Number.isFinite(weight) || weight <= 0)
  ) {
    fail(
      "Cent allocation requires positive stored weights.",
      "EXPEDIA_V2_ALLOCATION_INVALID"
    );
  }
  const weightTotal = safeWeights.reduce((sum, weight) => sum + weight, 0);
  const exact = safeWeights.map(
    (weight) => (totalCents * weight) / weightTotal
  );
  const cents = exact.map(Math.floor);
  let remainder = totalCents - cents.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort(
      (left, right) =>
        right.fraction - left.fraction || left.index - right.index
    );
  for (let index = 0; remainder > 0; index += 1) {
    cents[order[index % order.length].index] += 1;
    remainder -= 1;
  }
  return cents.map((value) => value / 100);
}

function buildWeightedPricing(reservation, { gross, payout }) {
  const slots = sourceSlots(reservation);
  const weights = slots.map((slot) => slot.sourceWeight);
  const grossSlots = allocateCentsByWeight(gross, weights);
  const payoutSlots = allocateCentsByWeight(payout, weights);
  if (payoutSlots.some((value, index) => value > grossSlots[index] + 0.004)) {
    fail(
      "A nightly payout exceeds its gross allocation.",
      "EXPEDIA_V2_ALLOCATION_INVALID"
    );
  }
  const rooms = cloneBson(reservation.pickedRoomsPricing);
  for (const [index, slot] of slots.entries()) {
    const day = rooms[slot.roomIndex].pricingByDay[slot.dayIndex];
    const client = round2(grossSlots[index]);
    const net = round2(payoutSlots[index]);
    Object.assign(day, {
      price: client,
      clientPrice: client,
      mainPrice: client,
      totalPriceWithCommission: client,
      netAfterExpenses: net,
      netAfterOtaExpenses: net,
      otaExpenseAmount: round2(client - net),
      platformMargin: round2(net - slot.rootWeight),
      commercialVerification: "authenticated_provider_portal_verified",
      hotelRunnerSourcePrice: round2(slot.sourceWeight),
    });
  }
  for (const room of rooms) {
    room.totalPriceWithCommission = round2(
      room.pricingByDay.reduce((sum, day) => sum + Number(day.clientPrice), 0)
    );
    room.hotelShouldGet = round2(
      room.pricingByDay.reduce((sum, day) => sum + Number(day.rootPrice), 0)
    );
    room.chosenPrice = round2(
      room.totalPriceWithCommission / room.pricingByDay.length
    );
  }
  const sum = (field) =>
    round2(
      rooms
        .flatMap((room) => room.pricingByDay)
        .reduce((total, day) => total + Number(day[field]), 0)
    );
  if (
    !sameMoney(sum("clientPrice"), gross) ||
    !sameMoney(sum("netAfterExpenses"), payout) ||
    !sameMoney(sum("otaExpenseAmount"), round2(gross - payout)) ||
    !sameMoney(sum("platformMargin"), round2(payout - TARGET.rootTotal))
  ) {
    fail(
      "The cent-exact room/day allocation does not reconcile.",
      "EXPEDIA_V2_ALLOCATION_INVALID"
    );
  }
  return rooms;
}

function rootEvidenceProjection(reservation = {}) {
  return {
    reservationHash: canonicalEjsonSha256(reservation),
    subTotal: reservation.sub_total,
    adminRootTotal: reservation.adminPricing?.rootTotal,
    hotelVisibleAmount: reservation.ota_financial_summary?.hotelVisibleAmount,
    rooms: (reservation.pickedRoomsPricing || []).map((room) => ({
      hotelRoomConfigId: clean(
        room?.hotelRoomConfigId || room?.localRoomConfigId
      ),
      hotelShouldGet: room?.hotelShouldGet,
      count: room?.count,
      pricingByDay: (room?.pricingByDay || []).map((day) => ({
        date: dateKey(day?.date),
        rootPrice: day?.rootPrice,
        totalPriceWithoutCommission: day?.totalPriceWithoutCommission,
        hotelRunnerSourcePrice: day?.hotelRunnerSourcePrice,
      })),
    })),
  };
}

function buildCommercialEvidence({
  reservation,
  event,
  job,
  portalSelection,
  lineage,
  plannedAt,
  execution,
}) {
  const portal = assertFreshPortalEvidence({
    job,
    portalSelection,
    lineage,
    plannedAt,
    execution,
    requireFresh: true,
  });
  const sourceJobHash = canonicalEjsonSha256(job);
  const rootHash = canonicalEjsonSha256(rootEvidenceProjection(reservation));
  const eventTimestamp =
    event?.sourceUpdatedAt || event?.receivedAt || event?.createdAt;
  const hotelBaseTimestamp =
    reservation?.createdAt || eventTimestamp || portal.sourceTimestamp;
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
    sourceTimestamp: portal.sourceTimestamp,
    sourceId: portalSelection.jobId,
    guestGross: {
      verified: true,
      amount: TARGET.portalGuestGross,
      currency: TARGET.sourceCurrency,
    },
    hotelPayout: {
      verified: true,
      amount: TARGET.hotelRunnerReportedAmount,
      currency: TARGET.sourceCurrency,
    },
    hotelBase: {
      verified: true,
      amount: TARGET.rootTotal,
      currency: TARGET.propertyCurrency,
      provenance: {
        provider: "jannat_pms",
        sourceType: "pms_root_pricing",
        sourceHash: rootHash,
        sourceTimestamp: hotelBaseTimestamp,
        sourceId: TARGET.reservationMongoId + ":root-pricing",
      },
    },
    hotelRunnerReportedAmount: {
      amount: TARGET.hotelRunnerReportedAmount,
      currency: TARGET.sourceCurrency,
      role: "hotel_payout",
      explicitRoleAssignment: true,
      provenance: {
        provider: "expedia",
        sourceType: "hotelrunner_webhook",
        sourceHash: TARGET.eventPayloadHash,
        sourceTimestamp: eventTimestamp,
        sourceId: TARGET.eventId,
      },
    },
    currencyConversion: portal.conversion,
  });
  const validation = validateOtaCommercialEvidence(evidence);
  const gross = evidence?.roles?.guestGross;
  const payout = evidence?.roles?.hotelPayout;
  const deduction = evidence?.roles?.deductionAggregate;
  if (
    !validation.ok ||
    evidence.verificationState !== "verified" ||
    evidence?.currencyConversion?.verified !== true ||
    !sameRate(evidence?.currencyConversion?.rate, portal.conversion.rate) ||
    !sameMoney(gross?.sourceAmount, TARGET.portalGuestGross) ||
    !sameMoney(gross?.propertyAmount, portal.gross) ||
    !sameMoney(payout?.sourceAmount, TARGET.hotelRunnerReportedAmount) ||
    !sameMoney(payout?.propertyAmount, portal.payout) ||
    !sameMoney(deduction?.sourceAmount, portal.sourceDeduction) ||
    !sameMoney(deduction?.propertyAmount, portal.deduction) ||
    evidence?.roles?.explicitOtaCommission?.verified !== false ||
    evidence?.roles?.explicitOtaCommission?.propertyAmount !== null
  ) {
    fail(
      "The common commercial contract did not produce the exact verified roles.",
      "EXPEDIA_V2_CONTRACT_INVALID"
    );
  }
  return {
    ...portal,
    evidence,
    sourceJobHash,
    rootHash,
    margin: round2(portal.payout - TARGET.rootTotal),
    conversionHash: canonicalEjsonSha256(portal.conversion),
  };
}

function optionalSourceMoney(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    fail(
      "An optional source payment amount is invalid.",
      "EXPEDIA_V2_PORTAL_MONEY_INVALID"
    );
  }
  return round2(number);
}

function materializedPaymentSummary(candidate, commercial, sourceJobHash) {
  const source = candidate?.paymentSummary || {};
  const convert = (value) => {
    const amount = optionalSourceMoney(value);
    return amount === null ? null : round2(amount * commercial.conversion.rate);
  };
  const fields = [
    ["sourceNightlyRateAmount", "nightlyRateAmount"],
    ["sourceTaxesAmount", "taxesAmount"],
    ["sourceExpediaCompensationAmount", "expediaCompensationAmount"],
    ["sourceAcceleratorAmount", "acceleratorAmount"],
  ];
  const optional = {};
  for (const [sourceField, propertyField] of fields) {
    const sourceValue = optionalSourceMoney(source[sourceField]);
    const propertyValue = convert(source[sourceField]);
    if (
      source[propertyField] !== null &&
      source[propertyField] !== undefined &&
      !sameMoney(source[propertyField], propertyValue)
    ) {
      fail(
        "A payment breakdown does not reconcile to trusted conversion.",
        "EXPEDIA_V2_PORTAL_MONEY_INVALID"
      );
    }
    optional[sourceField] = sourceValue;
    optional[propertyField] = propertyValue;
  }
  return {
    sourceType: "authenticated_provider_portal",
    sourceJobHash,
    paymentCollectionModel: "ota_collect",
    sourceCurrency: TARGET.sourceCurrency,
    propertyCurrency: TARGET.propertyCurrency,
    sourceTotalGuestPaymentAmount: TARGET.portalGuestGross,
    sourceTotalPayoutAmount: TARGET.hotelRunnerReportedAmount,
    sourceTotalPayoutCurrency: TARGET.sourceCurrency,
    totalGuestPaymentAmount: commercial.gross,
    totalPayoutAmount: commercial.payout,
    currency: TARGET.propertyCurrency,
    propertyConversionVerified: true,
    exchangeRateToSar: commercial.conversion.rate,
    exchangeRateSource: commercial.conversion.provenance.sourceType,
    amountConvertedAt: commercial.conversionFetchedAt.toISOString(),
    currencyConversionEvidence: cloneBson(commercial.conversion),
    ...optional,
  };
}

function protectedSnapshot(document = {}) {
  const snapshot = v1.commercialProtectedSnapshot(document);
  if (snapshot?.adminPricing) delete snapshot.adminPricing.commercialResolution;
  if (snapshot?.supplierData) {
    delete snapshot.supplierData.otaCommercialMaterializationRepair;
    delete snapshot.supplierData.otaCommercialEvidenceStaleReason;
  }
  snapshot.reservationAuditLog = (
    Array.isArray(snapshot.reservationAuditLog)
      ? snapshot.reservationAuditLog
      : []
  ).filter((entry) => clean(entry?.repairId) !== REPAIR_ID);
  return snapshot;
}

function repairAuditEntry({
  releaseSha,
  repairAt,
  originalHash,
  commercial,
  lineage,
}) {
  return {
    at: new Date(repairAt),
    source: "guarded-expedia-commercial-materialization",
    action: "trusted-conversion-commercial-materialization",
    provider: "expedia",
    repairId: REPAIR_ID,
    predecessorRepairId: v1.REPAIR_ID,
    releaseSha: lower(releaseSha),
    sourceJobHash: commercial.sourceJobHash,
    evidenceHash: commercial.evidence.evidenceHash,
    conversionEvidenceHash: commercial.conversionHash,
    originalDocumentHash: originalHash,
    predecessorManifestHash: lineage.manifestHash,
    predecessorBackupSetSha256: lineage.backup.backupSetSha256,
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
  evidenceAt = repairAt,
  portalSelection,
  lineage,
  execution,
}) {
  assertExactV1PostState(reservation, lineage);
  const originalHash = canonicalEjsonSha256(reservation);
  const commercial = buildCommercialEvidence({
    reservation,
    event,
    job,
    portalSelection,
    lineage,
    plannedAt: evidenceAt,
    execution,
  });
  const rooms = buildWeightedPricing(reservation, commercial);
  const paymentSummary = materializedPaymentSummary(
    commercial.candidate,
    commercial,
    commercial.sourceJobHash
  );
  const conversionSource = commercial.conversion.provenance.sourceType;
  const convertedAt = new Date(commercial.conversionFetchedAt);
  const next = cloneBson(reservation);
  next.total_amount = commercial.gross;
  next.commission = 0;
  next.commission_ota = null;
  next.pickedRoomsType = cloneBson(rooms);
  next.pickedRoomsPricing = cloneBson(rooms);
  next.adminPricing = {
    ...(next.adminPricing || {}),
    clientTotal: commercial.gross,
    netAfterExpensesTotal: commercial.payout,
    otaExpenseTotal: commercial.deduction,
    platformMarginTotal: commercial.margin,
    commissionAmount: 0,
    commercialVerified: true,
    commercialVerificationState: commercial.evidence.verificationState,
    commercialResolution: commercial.evidence.verificationState,
    commercialEvidenceHash: commercial.evidence.evidenceHash,
    defaultDeductionApplied: false,
    defaultDeductionRate: null,
    payoutFallbackReason: "",
    source: "authenticated_provider_portal",
    provider: "expedia",
    providerLabel: "Expedia",
    sourceCurrency: TARGET.sourceCurrency,
    propertyCurrency: TARGET.propertyCurrency,
    sourceAmount: TARGET.portalGuestGross,
    sourceGuestGross: TARGET.portalGuestGross,
    sourceHotelPayout: TARGET.hotelRunnerReportedAmount,
    propertyConversionVerified: true,
    hotelRunnerAmountRole: "hotel_payout",
    sourceExchangeRateToSar: commercial.conversion.rate,
    sourceExchangeRateSource: conversionSource,
    exchangeRateToSar: commercial.conversion.rate,
    exchangeRateSource: conversionSource,
    amountConvertedAt: convertedAt,
  };
  next.ota_financial_summary = {
    ...(next.ota_financial_summary || {}),
    show: true,
    source: "authenticated_provider_portal",
    provider: "expedia",
    providerLabel: "Expedia",
    currency: TARGET.propertyCurrency,
    clientTotal: commercial.gross,
    hotelVisibleAmount: TARGET.rootTotal,
    netAfterExpenses: commercial.payout,
    netAfterOtaExpenses: commercial.payout,
    otaExpenseTotal: commercial.deduction,
    platformProfit: commercial.margin,
    commissionAmount: 0,
    otaCommissionAmount: null,
    otaDeductionBreakdown: [],
    unclassifiedOtaDeduction: commercial.deduction,
    commercialVerified: true,
    commercialVerificationState: commercial.evidence.verificationState,
    commercialEvidenceHash: commercial.evidence.evidenceHash,
    sourceCurrency: TARGET.sourceCurrency,
    propertyCurrency: TARGET.propertyCurrency,
    sourceAmount: TARGET.portalGuestGross,
    sourceGuestGross: TARGET.portalGuestGross,
    sourceHotelPayout: TARGET.hotelRunnerReportedAmount,
    propertyConversionVerified: true,
    hotelRunnerAmountRole: "hotel_payout",
    paymentCollectionModel: "ota_collect",
    payoutFallbackReason: "",
    paymentSummary,
    sourceExchangeRateToSar: commercial.conversion.rate,
    sourceExchangeRateSource: conversionSource,
    exchangeRateToSar: commercial.conversion.rate,
    exchangeRateSource: conversionSource,
    amountConvertedAt: convertedAt,
  };
  next.supplierData = {
    ...(next.supplierData || {}),
    otaAmount: TARGET.portalGuestGross,
    otaAmountSar: commercial.gross,
    otaAmountConvertedAt: convertedAt,
    otaCurrency: TARGET.sourceCurrency,
    otaSourceCurrency: TARGET.sourceCurrency,
    otaSourceAmount: TARGET.portalGuestGross,
    otaSourceAmountHint:
      TARGET.sourceCurrency + " " + TARGET.portalGuestGross.toFixed(2),
    otaPropertyCurrency: TARGET.propertyCurrency,
    otaExchangeRateToSar: commercial.conversion.rate,
    otaExchangeRateSource: conversionSource,
    otaSourceExchangeRateToSar: commercial.conversion.rate,
    otaSourceExchangeRateSource: conversionSource,
    otaPaymentSummary: paymentSummary,
    otaPaymentCollectionModel: "ota_collect",
    otaDeductionComponents: [],
    otaTotalPayoutSar: commercial.payout,
    otaExpenseTotalSar: commercial.deduction,
    otaPlatformMarginSar: commercial.margin,
    otaCommissionSar: null,
    otaCommissionSource: "",
    otaCommissionSourceBacked: false,
    otaPayoutFallbackReason: "",
    otaCommercialEvidenceStaleReason: "",
    otaCommercialEvidence: cloneBson(commercial.evidence),
    otaCommercialMaterializationRepair: {
      repairId: REPAIR_ID,
      predecessorRepairId: v1.REPAIR_ID,
      releaseSha: lower(releaseSha),
      appliedAt: new Date(repairAt),
      sourceJobHash: commercial.sourceJobHash,
      evidenceHash: commercial.evidence.evidenceHash,
      conversionEvidenceHash: commercial.conversionHash,
      rootEvidenceHash: commercial.rootHash,
      originalDocumentHash: originalHash,
      predecessorManifestHash: lineage.manifestHash,
      predecessorBackupSetSha256: lineage.backup.backupSetSha256,
      propertyConversionVerified: true,
      vendorApiCalls: 0,
    },
  };
  next.reservationAuditLog = [
    ...(Array.isArray(next.reservationAuditLog)
      ? next.reservationAuditLog
      : []),
    repairAuditEntry({
      releaseSha,
      repairAt,
      originalHash,
      commercial,
      lineage,
    }),
  ];
  next.updatedAt = new Date(repairAt);
  next.__v = TARGET.reservationVersion + 2;
  assertPostconditions({
    before: reservation,
    after: next,
    commercial,
    lineage,
  });
  return {
    expectedDocument: next,
    commercial,
    paymentSummary,
  };
}

function assertPostconditions({ before, after, commercial, lineage }) {
  const validation = validateOtaCommercialEvidence(
    after?.supplierData?.otaCommercialEvidence
  );
  if (
    !validation.ok ||
    after?.supplierData?.otaCommercialEvidence?.evidenceHash !==
      commercial.evidence.evidenceHash
  ) {
    fail(
      "Persisted common commercial evidence is invalid.",
      "EXPEDIA_V2_POSTCONDITION_FAILED"
    );
  }
  const requiredAmounts = [
    [after?.total_amount, commercial.gross],
    [after?.adminPricing?.clientTotal, commercial.gross],
    [after?.adminPricing?.netAfterExpensesTotal, commercial.payout],
    [after?.adminPricing?.otaExpenseTotal, commercial.deduction],
    [after?.adminPricing?.platformMarginTotal, commercial.margin],
    [after?.ota_financial_summary?.clientTotal, commercial.gross],
    [after?.ota_financial_summary?.netAfterExpenses, commercial.payout],
    [after?.ota_financial_summary?.netAfterOtaExpenses, commercial.payout],
    [after?.ota_financial_summary?.otaExpenseTotal, commercial.deduction],
    [after?.ota_financial_summary?.platformProfit, commercial.margin],
    [after?.supplierData?.otaAmount, TARGET.portalGuestGross],
    [after?.supplierData?.otaAmountSar, commercial.gross],
    [after?.supplierData?.otaSourceAmount, TARGET.portalGuestGross],
    [after?.supplierData?.otaTotalPayoutSar, commercial.payout],
    [after?.supplierData?.otaExpenseTotalSar, commercial.deduction],
    [after?.supplierData?.otaPlatformMarginSar, commercial.margin],
  ];
  if (
    requiredAmounts.some(([actual, expected]) => !sameMoney(actual, expected))
  ) {
    fail(
      "A canonical commercial amount does not match the trusted plan.",
      "EXPEDIA_V2_POSTCONDITION_FAILED"
    );
  }
  const rates = [
    after?.adminPricing?.sourceExchangeRateToSar,
    after?.adminPricing?.exchangeRateToSar,
    after?.ota_financial_summary?.sourceExchangeRateToSar,
    after?.ota_financial_summary?.exchangeRateToSar,
    after?.supplierData?.otaExchangeRateToSar,
    after?.supplierData?.otaSourceExchangeRateToSar,
    after?.supplierData?.otaPaymentSummary?.exchangeRateToSar,
  ];
  if (
    rates.some((rate) => !sameRate(rate, commercial.conversion.rate)) ||
    after?.adminPricing?.commercialVerified !== true ||
    after?.ota_financial_summary?.commercialVerified !== true ||
    after?.adminPricing?.propertyConversionVerified !== true ||
    after?.ota_financial_summary?.propertyConversionVerified !== true ||
    after?.supplierData?.otaPaymentSummary?.propertyConversionVerified !==
      true ||
    after?.adminPricing?.commercialVerificationState !== "verified" ||
    after?.ota_financial_summary?.commercialVerificationState !== "verified" ||
    Number(after?.commission) !== 0 ||
    after?.commission_ota !== null ||
    after?.supplierData?.otaCommissionSar !== null ||
    after?.adminPricing?.defaultDeductionApplied !== false ||
    after?.adminPricing?.defaultDeductionRate !== null ||
    Number(after?.__v) !== TARGET.reservationVersion + 2
  ) {
    fail(
      "Verified conversion, commission, or version postcondition failed.",
      "EXPEDIA_V2_POSTCONDITION_FAILED"
    );
  }
  if (
    canonicalEjsonSha256(after?.pickedRoomsPricing) !==
      canonicalEjsonSha256(buildWeightedPricing(before, commercial)) ||
    canonicalEjsonSha256(after?.pickedRoomsType) !==
      canonicalEjsonSha256(after?.pickedRoomsPricing)
  ) {
    fail(
      "Room/day commercial allocations diverged from stored weights.",
      "EXPEDIA_V2_POSTCONDITION_FAILED"
    );
  }
  if (
    canonicalEjsonSha256(protectedSnapshot(before)) !==
      canonicalEjsonSha256(protectedSnapshot(after)) ||
    canonicalEjsonSha256(before?.supplierData?.otaCommercialRepair) !==
      canonicalEjsonSha256(after?.supplierData?.otaCommercialRepair) ||
    canonicalEjsonSha256(
      (before?.reservationAuditLog || []).filter(
        (entry) => clean(entry?.repairId) === v1.REPAIR_ID
      )
    ) !==
      canonicalEjsonSha256(
        (after?.reservationAuditLog || []).filter(
          (entry) => clean(entry?.repairId) === v1.REPAIR_ID
        )
      ) ||
    canonicalEjsonSha256(before?.supplierData?.hotelRunner) !==
      canonicalEjsonSha256(after?.supplierData?.hotelRunner)
  ) {
    fail(
      "A protected identity, lifecycle, guest, stay, room, root, payment, or v1 fact changed.",
      "EXPEDIA_V2_POSTCONDITION_FAILED"
    );
  }
  if (
    clean(after?.supplierData?.otaCommercialRepair?.repairId) !==
      v1.REPAIR_ID ||
    clean(after?.supplierData?.otaCommercialMaterializationRepair?.repairId) !==
      REPAIR_ID ||
    after?.supplierData?.otaCommercialMaterializationRepair
      ?.predecessorManifestHash !== lineage.manifestHash ||
    after?.supplierData?.otaCommercialMaterializationRepair
      ?.predecessorBackupSetSha256 !== lineage.backup.backupSetSha256
  ) {
    fail(
      "The v2 lineage markers are incomplete.",
      "EXPEDIA_V2_POSTCONDITION_FAILED"
    );
  }
  const v2Audits = (after?.reservationAuditLog || []).filter(
    (entry) => clean(entry?.repairId) === REPAIR_ID
  );
  if (v2Audits.length !== 1 || Number(v2Audits[0]?.vendorApiCalls) !== 0) {
    fail(
      "The reservation lacks one exact zero-call v2 audit.",
      "EXPEDIA_V2_POSTCONDITION_FAILED"
    );
  }
  assertOperationallySafe(after, before);
  return true;
}

function isV2Marker(reservation = {}) {
  return (
    clean(
      reservation?.supplierData?.otaCommercialMaterializationRepair?.repairId
    ) === REPAIR_ID
  );
}

function immutableScope(scope, portalSelection, lineage) {
  return {
    reservationHash: canonicalEjsonSha256(scope.reservation),
    eventHash: canonicalEjsonSha256(scope.event),
    mirrorHash: canonicalEjsonSha256(scope.mirror),
    portalJobHash: canonicalEjsonSha256(scope.job),
    portalSelectionHash: canonicalEjsonSha256(portalSelection),
    predecessorManifestHash: lineage.manifestHash,
    predecessorBackupSetSha256: lineage.backup.backupSetSha256,
  };
}

function buildReadyPlan({
  scope,
  lineage,
  releaseSha,
  repairAt,
  proofIssuedAt,
  evidenceAt = proofIssuedAt,
  portalSelection,
  execution,
}) {
  assertExactV1PostState(scope.reservation, lineage);
  const built = buildExpectedDocument({
    reservation: scope.reservation,
    event: scope.event,
    job: scope.job,
    releaseSha,
    repairAt,
    evidenceAt,
    portalSelection,
    lineage,
    execution,
  });
  const originalHash = canonicalEjsonSha256(scope.reservation);
  const expectedHash = canonicalEjsonSha256(built.expectedDocument);
  const protectedHash = canonicalEjsonSha256(
    protectedSnapshot(scope.reservation)
  );
  const immutable = immutableScope(scope, portalSelection, lineage);
  const proofBasis = {
    version: 2,
    action: "materialize_trusted_conversion",
    repairId: REPAIR_ID,
    releaseSha: lower(releaseSha),
    repairAt: new Date(repairAt).toISOString(),
    targetFingerprint: sha256(
      [
        TARGET.hotelId,
        TARGET.reservationMongoId,
        TARGET.pmsConfirmationNumber,
        TARGET.otaBookingId,
        TARGET.checkinDate,
        TARGET.checkoutDate,
      ].join(":")
    ),
    originalHash,
    expectedHash,
    protectedHash,
    evidenceHash: built.commercial.evidence.evidenceHash,
    conversionEvidenceHash: built.commercial.conversionHash,
    conversionRate: built.commercial.conversion.rate,
    immutable,
    executionTreeSha: execution.treeSha,
    executionFingerprint: execution.executionFingerprint,
    vendorApiCalls: 0,
  };
  return {
    state: "ready",
    repairId: REPAIR_ID,
    releaseSha: lower(releaseSha),
    plannedAt: new Date(repairAt),
    proofIssuedAt: new Date(proofIssuedAt),
    portalSelection,
    scope,
    lineage,
    immutable,
    execution,
    originalDocument: cloneBson(scope.reservation),
    expectedDocument: built.expectedDocument,
    originalHash,
    expectedHash,
    protectedHash,
    commercial: built.commercial,
    planHash: canonicalEjsonSha256(proofBasis),
  };
}

function scopeFromBackup(backup) {
  return {
    reservation: cloneBson(
      backup.byRole.get("reservation_before").originalDocument
    ),
    event: cloneBson(
      backup.byRole.get("hotelrunner_event_evidence").originalDocument
    ),
    mirror: cloneBson(
      backup.byRole.get("hotelrunner_mirror_evidence").originalDocument
    ),
    job: cloneBson(
      backup.byRole.get("expedia_portal_job_evidence").originalDocument
    ),
  };
}

async function loadPlan({
  db,
  releaseSha,
  plannedAt,
  portalSelection,
  execution: executionInput,
}) {
  const execution = normalizeExecutionAttestation(executionInput, releaseSha);
  const proofIssuedAt = exactDate(plannedAt, "forward proof issue timestamp");
  const lineage = await loadV1Lineage(db);
  const scope = await loadRawScope(db, portalSelection);
  assertPredecessorLiveEvidence(scope, lineage);
  const existingManifest = await db
    .collection(MANIFEST_COLLECTION)
    .findOne({ _id: REPAIR_ID }, primaryReadOptions());
  if (existingManifest?.state === "postverify_failed") {
    fail(
      "The repair is in durable manual-intervention state after failed postverification.",
      "EXPEDIA_V2_MANUAL_INTERVENTION_REQUIRED"
    );
  }
  if (isV2Marker(scope.reservation)) {
    const backup = await loadAndVerifyBackup(db, portalSelection);
    await verifyImmutableEvidenceAgainstBackup(db, backup);
    const reservationRecord = backup.byRole.get("reservation_before");
    const recoveredPlan = buildReadyPlan({
      scope: scopeFromBackup(backup),
      lineage,
      releaseSha,
      repairAt: backup.manifest.proofPlannedAt,
      proofIssuedAt,
      evidenceAt: backup.manifest.proofPlannedAt,
      portalSelection,
      execution,
    });
    assertManifestMatchesPlan(backup.manifest, recoveredPlan, [
      "backed_up",
      "applied_pending_postverify",
      "applied",
    ]);
    if (
      canonicalEjsonSha256(scope.reservation) !==
      reservationRecord.expectedRepairedHash
    ) {
      fail(
        "The marked v2 reservation is not its exact applied EJSON.",
        "EXPEDIA_V2_POST_STATE_INVALID"
      );
    }
    assertPostconditions({
      before: reservationRecord.originalDocument,
      after: scope.reservation,
      commercial: recoveredPlan.commercial,
      lineage,
    });
    if (backup.manifest.state === "backed_up") {
      fail(
        "A committed v2 target with a preterminal manifest is not a valid transactional state.",
        "EXPEDIA_V2_MANUAL_INTERVENTION_REQUIRED"
      );
    }
    if (backup.manifest.state === "applied_pending_postverify") {
      return {
        ...recoveredPlan,
        backup,
        resumeState: "applied_pending_postverify",
      };
    }
    await verifyPostcommitState(db, backup, recoveredPlan.expectedHash);
    return {
      ...recoveredPlan,
      state: "already_applied",
      scope,
      backup,
    };
  }
  assertExactV1PostState(scope.reservation, lineage);
  const repairAt = existingManifest?.proofPlannedAt || proofIssuedAt;
  const plan = buildReadyPlan({
    scope,
    lineage,
    releaseSha,
    repairAt,
    proofIssuedAt,
    portalSelection,
    execution,
  });
  if (!existingManifest) return plan;
  assertManifestMatchesPlan(existingManifest, plan, [
    "backing_up",
    "backed_up",
  ]);
  await assertExistingBackupFragments(db, plan);
  if (existingManifest.state === "backed_up") {
    const backup = await loadAndVerifyBackup(db, portalSelection);
    await verifyImmutableEvidenceAgainstBackup(db, backup);
    return { ...plan, backup, resumeState: "backed_up" };
  }
  return { ...plan, resumeState: "backing_up" };
}

function backupRecord({
  role,
  collection,
  document,
  expectedRepairedHash = "",
  capturedAt,
}) {
  const originalDocument = cloneBson(document);
  const originalEjson = v1.canonicalEjsonString(originalDocument);
  const originalHash = canonicalEjsonSha256(originalDocument);
  const base = {
    _id: REPAIR_ID + ":" + role,
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

const BACKUP_ROLES = Object.freeze([
  "reservation_before",
  "hotelrunner_event_evidence",
  "hotelrunner_mirror_evidence",
  "expedia_portal_job_evidence",
]);

function buildBackupRecords(plan) {
  if (plan.state !== "ready") {
    fail(
      "Only an exact ready plan can create v2 backups.",
      "EXPEDIA_V2_BACKUP_INVALID"
    );
  }
  return [
    backupRecord({
      role: BACKUP_ROLES[0],
      collection: COLLECTIONS.reservation,
      document: plan.originalDocument,
      expectedRepairedHash: plan.expectedHash,
      capturedAt: plan.plannedAt,
    }),
    backupRecord({
      role: BACKUP_ROLES[1],
      collection: COLLECTIONS.event,
      document: plan.scope.event,
      capturedAt: plan.plannedAt,
    }),
    backupRecord({
      role: BACKUP_ROLES[2],
      collection: COLLECTIONS.mirror,
      document: plan.scope.mirror,
      capturedAt: plan.plannedAt,
    }),
    backupRecord({
      role: BACKUP_ROLES[3],
      collection: COLLECTIONS.portalJob,
      document: plan.scope.job,
      capturedAt: plan.plannedAt,
    }),
  ];
}

const MANIFEST_IMMUTABLE_FIELDS = Object.freeze([
  "releaseSha",
  "planHash",
  "proofPlannedAt",
  "originalHash",
  "expectedRepairedHash",
  "protectedHash",
  "evidenceHash",
  "conversionEvidenceHash",
  "conversionRate",
  "backupCollection",
  "backupRecordCount",
  "backupRecordHashes",
  "backupSetSha256",
  "portalJobId",
  "portalJobNumber",
  "portalJobHash",
  "predecessorRepairId",
  "predecessorManifestHash",
  "predecessorBackupSetSha256",
  "executionTreeSha",
  "executionFingerprint",
  "vendorApiCalls",
]);

function manifestBasisForPlan(plan) {
  const records = buildBackupRecords(plan);
  const verified = verifyBackupRecords(records);
  return {
    records,
    verified,
    document: {
      _id: REPAIR_ID,
      repairId: REPAIR_ID,
      state: "backing_up",
      releaseSha: plan.releaseSha,
      planHash: plan.planHash,
      proofPlannedAt: new Date(plan.plannedAt),
      originalHash: plan.originalHash,
      expectedRepairedHash: plan.expectedHash,
      protectedHash: plan.protectedHash,
      evidenceHash: plan.commercial.evidence.evidenceHash,
      conversionEvidenceHash: plan.commercial.conversionHash,
      conversionRate: plan.commercial.conversion.rate,
      backupCollection: BACKUP_COLLECTION,
      backupRecordCount: records.length,
      backupRecordHashes: Object.fromEntries(
        records.map((record) => [record.role, record.recordHash])
      ),
      backupSetSha256: verified.backupSetSha256,
      portalJobId: plan.portalSelection.jobId,
      portalJobNumber: plan.portalSelection.jobNumber,
      portalJobHash: plan.commercial.sourceJobHash,
      predecessorRepairId: v1.REPAIR_ID,
      predecessorManifestHash: plan.lineage.manifestHash,
      predecessorBackupSetSha256: plan.lineage.backup.backupSetSha256,
      executionTreeSha: plan.execution.treeSha,
      executionFingerprint: plan.execution.executionFingerprint,
      vendorApiCalls: 0,
      createdAt: new Date(plan.plannedAt),
    },
  };
}

function assertManifestMatchesPlan(manifest, plan, allowedStates) {
  const expected = manifestBasisForPlan(plan).document;
  if (
    !manifest ||
    clean(manifest._id) !== REPAIR_ID ||
    clean(manifest.repairId) !== REPAIR_ID ||
    !allowedStates.includes(manifest.state) ||
    MANIFEST_IMMUTABLE_FIELDS.some(
      (field) =>
        canonicalEjsonSha256(manifest[field]) !==
        canonicalEjsonSha256(expected[field])
    )
  ) {
    fail(
      "An existing v2 manifest conflicts with the immutable approved plan.",
      "EXPEDIA_V2_MANIFEST_CONFLICT"
    );
  }
  return true;
}

async function assertExistingBackupFragments(db, plan) {
  const expected = new Map(
    buildBackupRecords(plan).map((record) => [record._id, record])
  );
  const saved = await findMany(
    db.collection(BACKUP_COLLECTION),
    { repairId: REPAIR_ID },
    BACKUP_ROLES.length + 1
  );
  if (
    saved.length > BACKUP_ROLES.length ||
    saved.some(
      (record) =>
        !expected.has(clean(record?._id)) ||
        canonicalEjsonSha256(record) !==
          canonicalEjsonSha256(expected.get(clean(record?._id)))
    )
  ) {
    fail(
      "An existing v2 backup fragment conflicts with the immutable plan.",
      "EXPEDIA_V2_BACKUP_INVALID"
    );
  }
  return true;
}

function verifyBackupRecords(records, manifest = null) {
  if (!Array.isArray(records) || records.length !== BACKUP_ROLES.length) {
    fail(
      "The v2 backup must contain exactly four full EJSON/BSON records.",
      "EXPEDIA_V2_BACKUP_INVALID"
    );
  }
  const byRole = new Map();
  for (const record of records) {
    const base = { ...record };
    delete base.recordHash;
    if (
      clean(record?.repairId) !== REPAIR_ID ||
      !BACKUP_ROLES.includes(record?.role) ||
      byRole.has(record?.role) ||
      canonicalEjsonSha256(base) !== record?.recordHash ||
      canonicalEjsonSha256(record?.originalDocument) !== record?.originalHash ||
      v1.canonicalEjsonString(record?.originalDocument) !==
        record?.originalEjson ||
      sha256(record?.originalEjson) !== record?.originalEjsonSha256
    ) {
      fail(
        "A v2 permanent backup record failed integrity.",
        "EXPEDIA_V2_BACKUP_INVALID"
      );
    }
    byRole.set(record.role, record);
  }
  if (BACKUP_ROLES.some((role) => !byRole.has(role))) {
    fail("A required v2 backup role is absent.", "EXPEDIA_V2_BACKUP_INVALID");
  }
  const exactBindings = [
    ["reservation_before", COLLECTIONS.reservation, TARGET.reservationMongoId],
    ["hotelrunner_event_evidence", COLLECTIONS.event, TARGET.eventId],
    ["hotelrunner_mirror_evidence", COLLECTIONS.mirror, TARGET.mirrorId],
  ];
  for (const [role, collection, documentId] of exactBindings) {
    const record = byRole.get(role);
    if (
      record.sourceCollection !== collection ||
      clean(record.documentId) !== documentId ||
      clean(record.originalDocument?._id) !== documentId
    ) {
      fail(
        "A v2 backup role is bound to the wrong source document.",
        "EXPEDIA_V2_BACKUP_INVALID"
      );
    }
  }
  const portalBinding = byRole.get("expedia_portal_job_evidence");
  if (
    portalBinding.sourceCollection !== COLLECTIONS.portalJob ||
    !ObjectId.isValid(clean(portalBinding.documentId)) ||
    clean(portalBinding.originalDocument?._id) !==
      clean(portalBinding.documentId)
  ) {
    fail(
      "The v2 portal backup is bound to the wrong source document.",
      "EXPEDIA_V2_BACKUP_INVALID"
    );
  }
  const backupSetSha256 = canonicalEjsonSha256(
    [...byRole.values()]
      .map((record) => ({ id: record._id, recordHash: record.recordHash }))
      .sort((left, right) => left.id.localeCompare(right.id))
  );
  if (manifest) {
    const portalRecord = byRole.get("expedia_portal_job_evidence");
    const reservationRecord = byRole.get("reservation_before");
    if (
      clean(manifest?._id) !== REPAIR_ID ||
      clean(manifest?.repairId) !== REPAIR_ID ||
      ![
        "backing_up",
        "backed_up",
        "applied_pending_postverify",
        "applied",
        "rolling_back",
        "rolled_back_pending_postverify",
        "rolled_back",
        "postverify_failed",
      ].includes(manifest?.state) ||
      !/^[a-f0-9]{40}$/.test(lower(manifest?.releaseSha)) ||
      !/^[a-f0-9]{64}$/.test(lower(manifest?.planHash)) ||
      !/^[a-f0-9]{40}$/.test(lower(manifest?.executionTreeSha)) ||
      !/^[a-f0-9]{64}$/.test(lower(manifest?.executionFingerprint)) ||
      !/^[a-f0-9]{64}$/.test(lower(manifest?.activeOwnerToken)) ||
      !Number.isSafeInteger(manifest?.activeAttemptNumber) ||
      manifest.activeAttemptNumber < 1 ||
      manifest?.activeExecutionFingerprint !== manifest?.executionFingerprint ||
      !/^[a-f0-9]{64}$/.test(lower(manifest?.evidenceHash)) ||
      !/^[a-f0-9]{64}$/.test(lower(manifest?.conversionEvidenceHash)) ||
      !Number.isFinite(Number(manifest?.conversionRate)) ||
      Number(manifest?.conversionRate) <= 0 ||
      manifest?.predecessorRepairId !== v1.REPAIR_ID ||
      !/^[a-f0-9]{64}$/.test(lower(manifest?.predecessorManifestHash)) ||
      !/^[a-f0-9]{64}$/.test(lower(manifest?.predecessorBackupSetSha256)) ||
      !hasExactNumericZero(manifest, "vendorApiCalls") ||
      manifest?.backupCollection !== BACKUP_COLLECTION ||
      Number(manifest?.backupRecordCount) !== BACKUP_ROLES.length ||
      manifest?.backupSetSha256 !== backupSetSha256 ||
      manifest?.originalHash !== reservationRecord.originalHash ||
      manifest?.expectedRepairedHash !==
        reservationRecord.expectedRepairedHash ||
      clean(manifest?.portalJobId) !== clean(portalRecord?.documentId) ||
      manifest?.portalJobHash !== portalRecord?.originalHash ||
      clean(portalRecord?.originalDocument?.jobNumber) !==
        clean(manifest?.portalJobNumber)
    ) {
      fail(
        "The v2 manifest no longer binds its permanent backup set.",
        "EXPEDIA_V2_BACKUP_INVALID"
      );
    }
    for (const record of records) {
      if (manifest?.backupRecordHashes?.[record.role] !== record.recordHash) {
        fail("A v2 manifest record hash changed.", "EXPEDIA_V2_BACKUP_INVALID");
      }
    }
    exactDate(manifest.proofPlannedAt, "v2 proof plan timestamp");
    const activeProofIssuedAt = exactDate(
      manifest.activeProofIssuedAt,
      "v2 active proof issue timestamp"
    );
    const activeProofExpiresAt = exactDate(
      manifest.activeProofExpiresAt,
      "v2 active proof expiry timestamp"
    );
    const activeLeaseExpiresAt = exactDate(
      manifest.activeLeaseExpiresAt,
      "v2 active owner lease expiry"
    );
    if (
      activeProofExpiresAt.getTime() - activeProofIssuedAt.getTime() !==
        PROOF_MAX_AGE_MS ||
      activeLeaseExpiresAt.getTime() > activeProofExpiresAt.getTime() ||
      activeLeaseExpiresAt.getTime() < activeProofIssuedAt.getTime()
    ) {
      fail(
        "The v2 active proof window is invalid.",
        "EXPEDIA_V2_BACKUP_INVALID"
      );
    }
    if (
      [
        "applied_pending_postverify",
        "applied",
        "rolling_back",
        "rolled_back_pending_postverify",
        "rolled_back",
        "postverify_failed",
      ].includes(manifest.state) &&
      (manifest.appliedDocumentHash !==
        reservationRecord.expectedRepairedHash ||
        !manifest.appliedAt)
    ) {
      fail(
        "The applied v2 manifest lacks its exact post-state.",
        "EXPEDIA_V2_BACKUP_INVALID"
      );
    }
    if (
      [
        "applied_pending_postverify",
        "applied",
        "rolling_back",
        "rolled_back_pending_postverify",
        "rolled_back",
        "postverify_failed",
      ].includes(manifest.state)
    ) {
      exactDate(manifest.appliedAt, "v2 applied timestamp");
    }
    if (
      [
        "rolling_back",
        "rolled_back_pending_postverify",
        "rolled_back",
      ].includes(manifest.state) ||
      (manifest.state === "postverify_failed" &&
        manifest.postverifyAction === "rollback")
    ) {
      const rollbackIssuedAt = exactDate(
        manifest.rollbackProofIssuedAt,
        "v2 rollback proof issue timestamp"
      );
      const rollbackExpiresAt = exactDate(
        manifest.rollbackProofExpiresAt,
        "v2 rollback proof expiry timestamp"
      );
      const rollbackLeaseExpiresAt = exactDate(
        manifest.rollbackLeaseExpiresAt,
        "v2 rollback owner lease expiry"
      );
      if (
        !/^[a-f0-9]{64}$/.test(lower(manifest.rollbackScopeHash)) ||
        !/^[a-f0-9]{64}$/.test(lower(manifest.rollbackPlanHash)) ||
        !/^[a-f0-9]{64}$/.test(
          lower(manifest.rollbackPredecessorManifestHash)
        ) ||
        !/^[a-f0-9]{64}$/.test(lower(manifest.rollbackOwnerToken)) ||
        !Number.isSafeInteger(manifest.rollbackAttemptNumber) ||
        manifest.rollbackAttemptNumber < 1 ||
        !/^[a-f0-9]{40}$/.test(lower(manifest.rollbackReleaseSha)) ||
        !/^[a-f0-9]{40}$/.test(lower(manifest.rollbackExecutionTreeSha)) ||
        !/^[a-f0-9]{64}$/.test(lower(manifest.rollbackExecutionFingerprint)) ||
        rollbackExpiresAt.getTime() - rollbackIssuedAt.getTime() !==
          PROOF_MAX_AGE_MS ||
        rollbackLeaseExpiresAt.getTime() > rollbackExpiresAt.getTime() ||
        rollbackLeaseExpiresAt.getTime() < rollbackIssuedAt.getTime()
      ) {
        fail(
          "The durable rollback authorization is invalid.",
          "EXPEDIA_V2_BACKUP_INVALID"
        );
      }
      const durableRollbackProof = {
        version: 2,
        action: "rollback",
        repairId: REPAIR_ID,
        releaseSha: lower(manifest.rollbackReleaseSha),
        proofIssuedAt: rollbackIssuedAt.toISOString(),
        rollbackScopeHash: manifest.rollbackScopeHash,
        originalHash: reservationRecord.originalHash,
        expectedRepairedHash: reservationRecord.expectedRepairedHash,
        backupSetSha256,
        manifestHash: manifest.rollbackPredecessorManifestHash,
        portalJobHash: portalRecord.originalHash,
        predecessorManifestHash: manifest.predecessorManifestHash,
        predecessorBackupSetSha256: manifest.predecessorBackupSetSha256,
        executionTreeSha: manifest.rollbackExecutionTreeSha,
        executionFingerprint: manifest.rollbackExecutionFingerprint,
        vendorApiCalls: 0,
      };
      if (
        canonicalEjsonSha256(durableRollbackProof) !== manifest.rollbackPlanHash
      ) {
        fail(
          "The durable rollback proof no longer matches its exact scope.",
          "EXPEDIA_V2_BACKUP_INVALID"
        );
      }
    }
    if (
      manifest.state === "rolled_back" &&
      (manifest.rollbackDocumentHash !== reservationRecord.originalHash ||
        !manifest.rolledBackAt)
    ) {
      fail(
        "The rolled-back v2 manifest lacks its exact restored state.",
        "EXPEDIA_V2_BACKUP_INVALID"
      );
    }
    if (manifest.state === "rolled_back") {
      exactDate(manifest.rolledBackAt, "v2 rollback timestamp");
    }
    if (
      manifest.state === "applied" &&
      (manifest.postverifyAction !== "forward" ||
        manifest.postverifyStatus !== "verified" ||
        !manifest.postverifiedAt ||
        !manifest.evidenceReverifiedAt)
    ) {
      fail(
        "The applied manifest lacks completed postverification.",
        "EXPEDIA_V2_BACKUP_INVALID"
      );
    }
    if (
      manifest.state === "rolled_back" &&
      (manifest.postverifyAction !== "rollback" ||
        manifest.postverifyStatus !== "verified" ||
        !manifest.postverifiedAt)
    ) {
      fail(
        "The rolled-back manifest lacks completed postverification.",
        "EXPEDIA_V2_BACKUP_INVALID"
      );
    }
    if (
      manifest.state === "applied_pending_postverify" &&
      (manifest.postverifyAction !== "forward" ||
        manifest.postverifyStatus !== "pending" ||
        !manifest.postverifyPendingAt)
    ) {
      fail(
        "The forward postverification state is invalid.",
        "EXPEDIA_V2_BACKUP_INVALID"
      );
    }
    if (
      manifest.state === "rolled_back_pending_postverify" &&
      (manifest.postverifyAction !== "rollback" ||
        manifest.postverifyStatus !== "pending" ||
        manifest.rollbackDocumentHash !== reservationRecord.originalHash ||
        !manifest.rolledBackPendingAt ||
        !manifest.postverifyPendingAt)
    ) {
      fail(
        "The rollback postverification state is invalid.",
        "EXPEDIA_V2_BACKUP_INVALID"
      );
    }
    if (
      manifest.state === "postverify_failed" &&
      (!["forward", "rollback"].includes(manifest.postverifyAction) ||
        manifest.postverifyStatus !== "failed" ||
        manifest.postverifyFailureCode !== "protected_artifact_drift" ||
        !/^[a-f0-9]{64}$/.test(
          lower(manifest.postverifyPredecessorManifestHash)
        ) ||
        !/^[a-f0-9]{64}$/.test(
          lower(manifest.postverifyExpectedReservationHash)
        ) ||
        (!/^[a-f0-9]{64}$/.test(
          lower(manifest.postverifyObservedReservationHash)
        ) &&
          manifest.postverifyObservedReservationHash !== "missing") ||
        ![
          "protected_artifact",
          "target_reservation",
          "identity_uniqueness",
        ].includes(manifest.postverifyDriftKind) ||
        !/^[a-f0-9]{64}$/.test(lower(manifest.postverifyExpectedHash)) ||
        (!/^[a-f0-9]{64}$/.test(lower(manifest.postverifyObservedHash)) &&
          manifest.postverifyObservedHash !== "missing") ||
        !/^[a-f0-9]{64}$/.test(lower(manifest.postverifyDriftScopeHash)) ||
        manifest.manualInterventionRequired !== true ||
        !manifest.postverifyFailedAt)
    ) {
      fail(
        "The durable postverification failure is invalid.",
        "EXPEDIA_V2_BACKUP_INVALID"
      );
    }
    if (
      manifest.state === "postverify_failed" &&
      ((manifest.postverifyAction === "forward" &&
        manifest.postverifyExpectedReservationHash !==
          reservationRecord.expectedRepairedHash) ||
        (manifest.postverifyAction === "rollback" &&
          manifest.postverifyExpectedReservationHash !==
            reservationRecord.originalHash))
    ) {
      fail(
        "The failed postverification is bound to the wrong target state.",
        "EXPEDIA_V2_BACKUP_INVALID"
      );
    }
  }
  return { byRole, backupSetSha256 };
}

async function readBackupRecords(db, session = null) {
  const records = [];
  for (const role of BACKUP_ROLES) {
    const record = await db
      .collection(BACKUP_COLLECTION)
      .findOne({ _id: REPAIR_ID + ":" + role }, primaryReadOptions(session));
    if (record) records.push(record);
  }
  return records;
}

async function loadAndVerifyBackup(db, portalSelection) {
  const manifest = await db
    .collection(MANIFEST_COLLECTION)
    .findOne({ _id: REPAIR_ID }, primaryReadOptions());
  if (
    !manifest ||
    clean(manifest?.portalJobId) !== portalSelection.jobId ||
    clean(manifest?.portalJobNumber) !== portalSelection.jobNumber
  ) {
    fail(
      "The v2 manifest is absent or bound to different evidence.",
      "EXPEDIA_V2_BACKUP_INVALID"
    );
  }
  const records = await readBackupRecords(db);
  const verified = verifyBackupRecords(records, manifest);
  const lineage = await loadV1Lineage(db);
  const reservationRecord = verified.byRole.get("reservation_before");
  const eventRecord = verified.byRole.get("hotelrunner_event_evidence");
  const mirrorRecord = verified.byRole.get("hotelrunner_mirror_evidence");
  const v1EventRecord = lineage.backup.byRole.get("hotelrunner_event_evidence");
  const v1MirrorRecord = lineage.backup.byRole.get(
    "hotelrunner_mirror_evidence"
  );
  if (
    manifest?.predecessorRepairId !== v1.REPAIR_ID ||
    manifest?.predecessorManifestHash !== lineage.manifestHash ||
    manifest?.predecessorBackupSetSha256 !== lineage.backup.backupSetSha256 ||
    !reservationRecord ||
    reservationRecord.originalHash !== lineage.expectedHash ||
    canonicalEjsonSha256(reservationRecord.originalDocument) !==
      lineage.expectedHash ||
    canonicalEjsonSha256(reservationRecord.originalDocument) !==
      canonicalEjsonSha256(lineage.expectedDocument) ||
    !eventRecord ||
    !mirrorRecord ||
    !v1EventRecord ||
    !v1MirrorRecord ||
    eventRecord.originalHash !== v1EventRecord.originalHash ||
    mirrorRecord.originalHash !== v1MirrorRecord.originalHash
  ) {
    fail(
      "The v2 backup no longer equals the independently reconstructed v1 lineage.",
      "EXPEDIA_V2_V1_LINEAGE_INVALID"
    );
  }
  return { manifest, records, lineage, ...verified };
}

async function replaceManifestByExactCas({
  db,
  before,
  after,
  session = null,
}) {
  let acknowledgementError = null;
  try {
    const result = await db
      .collection(MANIFEST_COLLECTION)
      .replaceOne(
        buildV2ExactCasFilter(before),
        cloneBson(after),
        majorityWriteOptions(session)
      );
    if (
      result?.acknowledged === false ||
      Number(result?.matchedCount ?? result?.n ?? 0) !== 1 ||
      Number(result?.modifiedCount ?? result?.nModified ?? 0) !== 1
    ) {
      throw new Error("manifest CAS rejected");
    }
  } catch (error) {
    acknowledgementError = error;
  }
  const observed = await db
    .collection(MANIFEST_COLLECTION)
    .findOne({ _id: REPAIR_ID }, primaryReadOptions(session));
  const observedHash = observed ? canonicalEjsonSha256(observed) : "";
  if (observedHash === canonicalEjsonSha256(after)) {
    return {
      manifest: observed,
      acknowledgementLost: Boolean(acknowledgementError),
    };
  }
  if (observedHash === canonicalEjsonSha256(before)) {
    fail(
      "The exact manifest CAS did not commit.",
      "EXPEDIA_V2_MANIFEST_CONFLICT"
    );
  }
  fail(
    "The manifest changed to an unapproved state during exact CAS.",
    "EXPEDIA_V2_MANIFEST_CONFLICT"
  );
}

async function replaceManifestExactly({
  db,
  before,
  set,
  plan,
  capability,
  action,
  session = null,
}) {
  assertMutationCapability(capability, plan, action);
  return replaceManifestByExactCas({
    db,
    before,
    after: { ...cloneBson(before), ...cloneBson(set) },
    session,
  });
}

function forwardAttemptFields(capability, attemptNumber, now) {
  const leaseExpiresAt = new Date(
    Math.min(
      now.getTime() + OWNER_LEASE_MS,
      capability.proofExpiresAt.getTime()
    )
  );
  return {
    activeOwnerToken: capability.ownerToken,
    activeAttemptNumber: attemptNumber,
    activeProofIssuedAt: new Date(capability.proofIssuedAt),
    activeProofExpiresAt: new Date(capability.proofExpiresAt),
    activeExecutionFingerprint: capability.executionFingerprint,
    activeLeaseExpiresAt: leaseExpiresAt,
  };
}

function assertForwardLease(manifest, capability, now) {
  const leaseExpiresAt = exactDate(
    manifest?.activeLeaseExpiresAt,
    "forward owner lease expiry"
  );
  if (
    manifest?.activeOwnerToken !== capability.ownerToken ||
    leaseExpiresAt.getTime() < now.getTime() + OWNER_WRITE_SAFETY_MS ||
    leaseExpiresAt.getTime() > capability.proofExpiresAt.getTime()
  ) {
    fail(
      "The forward owner lease is absent, stolen, or too close to expiry.",
      "EXPEDIA_V2_OWNER_LEASE_INVALID"
    );
  }
  return true;
}

async function claimForwardManifest(db, plan, capability) {
  const manifests = db.collection(MANIFEST_COLLECTION);
  const basis = manifestBasisForPlan(plan);
  let existing = await manifests.findOne(
    { _id: REPAIR_ID },
    primaryReadOptions()
  );
  if (!existing) {
    const now = assertMutationCapability(capability, plan, "forward");
    const initial = {
      ...basis.document,
      ...forwardAttemptFields(capability, 1, now),
    };
    try {
      await manifests.insertOne(cloneBson(initial), majorityWriteOptions());
      existing = initial;
    } catch (_error) {
      existing = await manifests.findOne(
        { _id: REPAIR_ID },
        primaryReadOptions()
      );
      if (canonicalEjsonSha256(existing) === canonicalEjsonSha256(initial)) {
        return { manifest: existing, basis };
      }
    }
  }
  assertManifestMatchesPlan(existing, plan, ["backing_up", "backed_up"]);
  if (existing.activeOwnerToken !== capability.ownerToken) {
    const now = assertMutationCapability(capability, plan, "forward");
    const existingLeaseExpiresAt = exactDate(
      existing.activeLeaseExpiresAt,
      "existing forward owner lease expiry"
    );
    if (existingLeaseExpiresAt.getTime() > now.getTime()) {
      fail(
        "Another forward execution still owns the unexpired manifest lease.",
        "EXPEDIA_V2_OWNER_LEASE_ACTIVE"
      );
    }
    const attemptNumber = Number(existing.activeAttemptNumber) + 1;
    if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 2) {
      fail(
        "The manifest attempt counter is invalid.",
        "EXPEDIA_V2_MANIFEST_CONFLICT"
      );
    }
    existing = (
      await replaceManifestExactly({
        db,
        before: existing,
        set: forwardAttemptFields(capability, attemptNumber, now),
        plan,
        capability,
        action: "forward",
      })
    ).manifest;
  }
  assertForwardLease(
    existing,
    capability,
    assertMutationCapability(capability, plan, "forward")
  );
  return { manifest: existing, basis };
}

async function claimForwardPendingPostverify(db, plan, capability) {
  let backup = await loadAndVerifyBackup(db, plan.portalSelection);
  assertManifestMatchesPlan(backup.manifest, plan, [
    "applied_pending_postverify",
  ]);
  let manifest = backup.manifest;
  if (manifest.activeOwnerToken !== capability.ownerToken) {
    const now = assertMutationCapability(capability, plan, "forward");
    const leaseExpiresAt = exactDate(
      manifest.activeLeaseExpiresAt,
      "pending forward owner lease expiry"
    );
    if (leaseExpiresAt.getTime() > now.getTime()) {
      fail(
        "Another forward execution still owns pending postverification.",
        "EXPEDIA_V2_OWNER_LEASE_ACTIVE"
      );
    }
    const attemptNumber = Number(manifest.activeAttemptNumber) + 1;
    if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 2) {
      fail(
        "The pending forward attempt counter is invalid.",
        "EXPEDIA_V2_MANIFEST_CONFLICT"
      );
    }
    manifest = (
      await replaceManifestExactly({
        db,
        before: manifest,
        set: forwardAttemptFields(capability, attemptNumber, now),
        plan,
        capability,
        action: "forward",
      })
    ).manifest;
  }
  assertForwardLease(
    manifest,
    capability,
    assertMutationCapability(capability, plan, "forward")
  );
  backup = { ...backup, manifest };
  return backup;
}

async function ensureBackup(db, plan, capability) {
  let { manifest: existing, basis } = await claimForwardManifest(
    db,
    plan,
    capability
  );
  const backups = db.collection(BACKUP_COLLECTION);
  for (const record of basis.records) {
    const saved = await backups.findOne(
      { _id: record._id },
      primaryReadOptions()
    );
    if (!saved) {
      assertForwardLease(
        existing,
        capability,
        assertMutationCapability(capability, plan, "forward")
      );
      try {
        await backups.insertOne(cloneBson(record), majorityWriteOptions());
      } catch (_error) {
        const raced = await backups.findOne(
          { _id: record._id },
          primaryReadOptions()
        );
        if (
          !raced ||
          canonicalEjsonSha256(raced) !== canonicalEjsonSha256(record)
        ) {
          fail(
            "A v2 permanent backup could not be persisted.",
            "EXPEDIA_V2_BACKUP_INVALID"
          );
        }
      }
    } else if (canonicalEjsonSha256(saved) !== canonicalEjsonSha256(record)) {
      fail(
        "An existing v2 permanent backup conflicts.",
        "EXPEDIA_V2_BACKUP_INVALID"
      );
    }
  }
  verifyBackupRecords(await readBackupRecords(db), existing);
  if (existing.state === "backing_up") {
    assertForwardLease(
      existing,
      capability,
      assertMutationCapability(capability, plan, "forward")
    );
    existing = (
      await replaceManifestExactly({
        db,
        before: existing,
        set: { state: "backed_up", backupVerifiedAt: new Date() },
        plan,
        capability,
        action: "forward",
      })
    ).manifest;
  }
  const backup = await loadAndVerifyBackup(db, plan.portalSelection);
  assertManifestMatchesPlan(backup.manifest, plan, ["backed_up"]);
  if (backup.manifest.activeOwnerToken !== capability.ownerToken) {
    fail(
      "The forward manifest owner changed during backup.",
      "EXPEDIA_V2_MANIFEST_CONFLICT"
    );
  }
  return backup;
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
      fail(
        "Immutable v2 evidence changed after backup.",
        "EXPEDIA_V2_EVIDENCE_TAMPERED"
      );
    }
  }
  const lineage = await loadV1Lineage(db);
  if (
    lineage.manifestHash !== backup.manifest.predecessorManifestHash ||
    lineage.backup.backupSetSha256 !==
      backup.manifest.predecessorBackupSetSha256
  ) {
    fail(
      "Immutable v1 lineage changed after v2 backup.",
      "EXPEDIA_V2_V1_LINEAGE_INVALID"
    );
  }
}

async function replaceWithHashReadback({
  collection,
  before,
  after,
  beforeHash,
  afterHash,
  documentLabel = "reservation",
  session = null,
}) {
  if (!owns(before, "_id")) {
    fail("An exact replacement document lacks _id.", "EXPEDIA_V2_CAS_INVALID");
  }
  let acknowledgementError = null;
  try {
    const result = await collection.replaceOne(
      buildV2ExactCasFilter(before),
      cloneBson(after),
      majorityWriteOptions(session)
    );
    if (
      result?.acknowledged === false ||
      Number(result?.matchedCount ?? result?.n ?? 0) !== 1 ||
      Number(result?.modifiedCount ?? result?.nModified ?? 0) !== 1
    ) {
      throw new Error("cas rejected");
    }
  } catch (error) {
    acknowledgementError = error;
  }
  const observed = await collection.findOne(
    { _id: cloneBson(before._id) },
    primaryReadOptions(session)
  );
  const observedHash = observed ? canonicalEjsonSha256(observed) : "";
  if (observedHash === afterHash) {
    return {
      document: observed,
      acknowledgementLost: Boolean(acknowledgementError),
    };
  }
  if (observedHash === beforeHash) {
    fail("The full-document CAS did not commit.", "EXPEDIA_V2_CAS_REJECTED");
  }
  fail(
    "The " + documentLabel + " is neither exact before nor exact after EJSON.",
    "EXPEDIA_V2_MANUAL_INTERVENTION_REQUIRED"
  );
}

async function reloadBoundForwardBackup(db, plan, capability) {
  const backup = await loadAndVerifyBackup(db, plan.portalSelection);
  assertManifestMatchesPlan(backup.manifest, plan, ["backed_up"]);
  assertForwardLease(
    backup.manifest,
    capability,
    assertMutationCapability(capability, plan, "forward")
  );
  await verifyImmutableEvidenceAgainstBackup(db, backup);
  return backup;
}

async function verifyTerminalBackupSnapshot(db, backup, session) {
  const manifest = await db
    .collection(MANIFEST_COLLECTION)
    .findOne({ _id: REPAIR_ID }, primaryReadOptions(session));
  if (
    !manifest ||
    canonicalEjsonSha256(manifest) !== canonicalEjsonSha256(backup.manifest)
  ) {
    fail(
      "The terminal transaction no longer owns the exact manifest.",
      "EXPEDIA_V2_MANIFEST_CONFLICT"
    );
  }
  const records = await readBackupRecords(db, session);
  verifyBackupRecords(records, manifest);
  if (canonicalEjsonSha256(records) !== canonicalEjsonSha256(backup.records)) {
    fail(
      "The permanent backup changed before terminal commit.",
      "EXPEDIA_V2_BACKUP_INVALID"
    );
  }
  return true;
}

function terminalImmutableInputs(backup) {
  const inputs = [];
  const add = (collection, document, label) => {
    if (!document || typeof document !== "object" || !owns(document, "_id")) {
      fail(
        "A terminal immutable input is missing its exact document.",
        "EXPEDIA_V2_BACKUP_INVALID"
      );
    }
    inputs.push({ collection, document: cloneBson(document), label });
  };
  for (const record of backup.records) {
    add(BACKUP_COLLECTION, record, "v2 backup record");
  }
  for (const [role, collection, label] of [
    ["hotelrunner_event_evidence", COLLECTIONS.event, "live event evidence"],
    ["hotelrunner_mirror_evidence", COLLECTIONS.mirror, "live mirror evidence"],
    [
      "expedia_portal_job_evidence",
      COLLECTIONS.portalJob,
      "fresh portal evidence",
    ],
  ]) {
    add(collection, backup.byRole.get(role)?.originalDocument, label);
  }
  add(v1.MANIFEST_COLLECTION, backup.lineage.manifest, "v1 manifest");
  for (const record of backup.lineage.backup.byRole.values()) {
    add(v1.BACKUP_COLLECTION, record, "v1 backup record");
  }
  add(
    COLLECTIONS.portalJob,
    backup.lineage.backup.byRole.get("expedia_portal_job_evidence")
      ?.originalDocument,
    "v1 portal evidence"
  );
  const unique = new Map();
  for (const input of inputs) {
    const key = input.collection + "\u0000" + clean(input.document._id);
    const existing = unique.get(key);
    if (
      existing &&
      canonicalEjsonSha256(existing.document) !==
        canonicalEjsonSha256(input.document)
    ) {
      fail(
        "Two immutable proofs disagree about the same source document.",
        "EXPEDIA_V2_BACKUP_INVALID"
      );
    }
    if (!existing) unique.set(key, input);
  }
  return [...unique.values()];
}

async function verifyTerminalImmutableInputs(db, backup, session = null) {
  await verifyTerminalBackupSnapshot(db, backup, session);
  for (const input of terminalImmutableInputs(backup)) {
    const current = await db
      .collection(input.collection)
      .findOne(
        { _id: cloneBson(input.document._id) },
        primaryReadOptions(session)
      );
    if (
      !current ||
      canonicalEjsonSha256(current) !== canonicalEjsonSha256(input.document)
    ) {
      fail(
        "An immutable " + input.label + " changed before terminal commit.",
        "EXPEDIA_V2_PROTECTED_ARTIFACT_DRIFT"
      );
    }
  }
  await verifyIdentityBoundary({ db, session });
  return true;
}

async function verifyPostcommitState(db, backup, expectedReservationHash) {
  const reservation = await db
    .collection(COLLECTIONS.reservation)
    .findOne(
      { _id: objectId(TARGET.reservationMongoId) },
      primaryReadOptions()
    );
  const observedReservationHash = reservation
    ? canonicalEjsonSha256(reservation)
    : "missing";
  if (observedReservationHash !== expectedReservationHash) {
    failProtectedDrift({
      kind: "target_reservation",
      expectedHash: expectedReservationHash,
      observedHash: observedReservationHash,
      scopeHash: sha256(
        COLLECTIONS.reservation + "\u0000" + TARGET.reservationMongoId
      ),
      observedReservationHash,
    });
  }
  for (const input of terminalImmutableInputs(backup)) {
    const current = await db
      .collection(input.collection)
      .findOne({ _id: cloneBson(input.document._id) }, primaryReadOptions());
    if (
      !current ||
      canonicalEjsonSha256(current) !== canonicalEjsonSha256(input.document)
    ) {
      failProtectedDrift({
        kind: "protected_artifact",
        expectedHash: canonicalEjsonSha256(input.document),
        observedHash: current ? canonicalEjsonSha256(current) : "missing",
        scopeHash: sha256(
          input.collection + "\u0000" + clean(input.document._id)
        ),
        observedReservationHash,
      });
    }
  }
  await verifyIdentityBoundary({
    db,
    observedReservationHash,
    postcommit: true,
  });
  return true;
}

async function stageAppliedManifest(db, plan, backup, capability, session) {
  const now = assertMutationCapability(capability, plan, "forward");
  assertForwardLease(backup.manifest, capability, now);
  return (
    await replaceManifestExactly({
      db,
      before: backup.manifest,
      set: {
        state: "applied_pending_postverify",
        appliedAt: now,
        appliedDocumentHash: plan.expectedHash,
        postverifyAction: "forward",
        postverifyStatus: "pending",
        postverifyPendingAt: now,
        vendorApiCalls: 0,
      },
      plan,
      capability,
      action: "forward",
      session,
    })
  ).manifest;
}

function postverifyFailureFields(action, plan, manifest, error, failedAt) {
  return {
    state: "postverify_failed",
    postverifyStatus: "failed",
    postverifyFailedAt: failedAt,
    postverifyFailureCode: "protected_artifact_drift",
    postverifyPredecessorManifestHash: canonicalEjsonSha256(manifest),
    postverifyExpectedReservationHash:
      action === "forward" ? plan.expectedHash : plan.originalHash,
    postverifyObservedReservationHash: error.observedReservationHash,
    postverifyDriftKind: error.driftKind,
    postverifyExpectedHash: error.expectedHash,
    postverifyObservedHash: error.observedHash,
    postverifyDriftScopeHash: error.scopeHash,
    manualInterventionRequired: true,
    vendorApiCalls: 0,
  };
}

function assertPostverifyFailureAuthority(manifest, capability, plan, action) {
  const failedAt = assertCapabilityBinding(capability, plan, action);
  const pendingState =
    action === "forward"
      ? "applied_pending_postverify"
      : "rolled_back_pending_postverify";
  if (
    manifest?.state !== pendingState ||
    manifest?.postverifyAction !== action ||
    manifest?.postverifyStatus !== "pending"
  ) {
    fail(
      "Only the exact pending manifest can record postverification failure.",
      "EXPEDIA_V2_MANIFEST_CONFLICT"
    );
  }
  if (
    (action === "forward" &&
      (manifest.activeOwnerToken !== capability.ownerToken ||
        manifest.activeExecutionFingerprint !==
          capability.executionFingerprint)) ||
    (action === "rollback" &&
      (manifest.rollbackOwnerToken !== capability.ownerToken ||
        manifest.rollbackPlanHash !== plan.planHash ||
        manifest.rollbackScopeHash !== plan.rollbackScopeHash ||
        manifest.rollbackExecutionFingerprint !==
          capability.executionFingerprint))
  ) {
    fail(
      "Postverification failure authority no longer owns the exact pending manifest.",
      "EXPEDIA_V2_MANIFEST_CONFLICT"
    );
  }
  return failedAt;
}

async function markPostverifyFailed({
  db,
  plan,
  manifest,
  capability,
  action,
  error,
}) {
  const failedAt = assertPostverifyFailureAuthority(
    manifest,
    capability,
    plan,
    action
  );
  if (
    error?.code !== "EXPEDIA_V2_PROTECTED_ARTIFACT_DRIFT" ||
    ![
      "protected_artifact",
      "target_reservation",
      "identity_uniqueness",
    ].includes(error?.driftKind) ||
    !/^[a-f0-9]{64}$/.test(lower(error?.expectedHash)) ||
    (!/^[a-f0-9]{64}$/.test(lower(error?.observedHash)) &&
      error?.observedHash !== "missing") ||
    !/^[a-f0-9]{64}$/.test(lower(error?.scopeHash)) ||
    (!/^[a-f0-9]{64}$/.test(lower(error?.observedReservationHash)) &&
      error?.observedReservationHash !== "missing")
  ) {
    fail(
      "Postverification failure evidence is invalid.",
      "EXPEDIA_V2_MANIFEST_CONFLICT"
    );
  }
  const after = {
    ...cloneBson(manifest),
    ...cloneBson(
      postverifyFailureFields(action, plan, manifest, error, failedAt)
    ),
  };
  return (await replaceManifestByExactCas({ db, before: manifest, after }))
    .manifest;
}

async function completeForwardPostverify(db, plan, backup, capability) {
  assertManifestMatchesPlan(backup.manifest, plan, [
    "applied_pending_postverify",
  ]);
  try {
    await verifyPostcommitState(db, backup, plan.expectedHash);
  } catch (error) {
    if (error?.code !== "EXPEDIA_V2_PROTECTED_ARTIFACT_DRIFT") throw error;
    await markPostverifyFailed({
      db,
      plan,
      manifest: backup.manifest,
      capability,
      action: "forward",
      error,
    });
    fail(
      "Forward postverification detected protected drift; manual intervention is required.",
      "EXPEDIA_V2_MANUAL_INTERVENTION_REQUIRED"
    );
  }
  const verifiedAt = assertMutationCapability(capability, plan, "forward");
  assertForwardLease(backup.manifest, capability, verifiedAt);
  const finalized = (
    await replaceManifestExactly({
      db,
      before: backup.manifest,
      set: {
        state: "applied",
        postverifyStatus: "verified",
        postverifiedAt: verifiedAt,
        evidenceReverifiedAt: verifiedAt,
        vendorApiCalls: 0,
      },
      plan,
      capability,
      action: "forward",
    })
  ).manifest;
  return finalized;
}

async function requireTransactionClient(db) {
  let hello;
  try {
    hello = await db.admin().command({ hello: 1 });
  } catch (_error) {
    fail(
      "MongoDB transaction topology could not be verified.",
      "EXPEDIA_V2_TRANSACTION_REQUIRED"
    );
  }
  const transactionTopology =
    clean(hello?.setName) !== "" || clean(hello?.msg) === "isdbgrid";
  const client = db?.s?.client || db?.client;
  if (
    !transactionTopology ||
    !client ||
    typeof client.startSession !== "function"
  ) {
    fail(
      "This repair requires a transaction-capable replica set or mongos.",
      "EXPEDIA_V2_TRANSACTION_REQUIRED"
    );
  }
  return client;
}

async function runTerminalTransaction(client, work) {
  const session = client.startSession();
  if (
    !session ||
    typeof session.withTransaction !== "function" ||
    typeof session.endSession !== "function"
  ) {
    fail(
      "MongoDB did not provide a usable transaction session.",
      "EXPEDIA_V2_TRANSACTION_REQUIRED"
    );
  }
  let result;
  try {
    await session.withTransaction(
      async () => {
        result = await work(session);
        return result;
      },
      {
        readPreference: "primary",
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" },
      }
    );
    return result;
  } catch (error) {
    if (clean(error?.code).startsWith("EXPEDIA_V2_")) throw error;
    fail(
      "The atomic reservation and manifest transaction aborted.",
      "EXPEDIA_V2_TRANSACTION_ABORTED"
    );
  } finally {
    await session.endSession();
  }
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
  if (plan.state !== "ready") {
    fail("Only an exact ready plan can be applied.", "EXPEDIA_V2_PLAN_INVALID");
  }
  assertMutationCapability(capability, plan, "forward");
  await v1.assertWritablePrimary(db);
  const transactionClient = await requireTransactionClient(db);
  if (plan.resumeState === "applied_pending_postverify") {
    const pendingBackup = await claimForwardPendingPostverify(
      db,
      plan,
      capability
    );
    await completeForwardPostverify(db, plan, pendingBackup, capability);
    return {
      state: "applied",
      changed: 0,
      resumed: true,
      acknowledgementLost: false,
      backupSetSha256: pendingBackup.backupSetSha256,
      vendorApiCalls: 0,
    };
  }
  let backup = await ensureBackup(db, plan, capability);
  backup = await reloadBoundForwardBackup(db, plan, capability);
  const reservationRecord = backup.byRole.get("reservation_before");
  if (
    reservationRecord.originalHash !== plan.originalHash ||
    reservationRecord.expectedRepairedHash !== plan.expectedHash
  ) {
    fail(
      "The permanent reservation backup conflicts with the plan.",
      "EXPEDIA_V2_BACKUP_INVALID"
    );
  }
  backup = await reloadBoundForwardBackup(db, plan, capability);
  const terminal = await runTerminalTransaction(
    transactionClient,
    async (session) => {
      await verifyTerminalImmutableInputs(db, backup, session);
      const current = await db
        .collection(COLLECTIONS.reservation)
        .findOne(
          { _id: objectId(TARGET.reservationMongoId) },
          primaryReadOptions(session)
        );
      if (!current) {
        fail(
          "The reservation changed after the approved dry run.",
          "EXPEDIA_V2_CAS_REJECTED"
        );
      }
      const currentHash = canonicalEjsonSha256(current);
      let replacement;
      let changed = 0;
      let resumed = false;
      if (currentHash === plan.originalHash) {
        assertExactV1PostState(current, plan.lineage);
        const mutationNow = assertMutationCapability(
          capability,
          plan,
          "forward"
        );
        assertForwardLease(backup.manifest, capability, mutationNow);
        assertCommercialEvidenceFreshAt(plan, mutationNow);
        replacement = await replaceWithHashReadback({
          collection: db.collection(COLLECTIONS.reservation),
          before: plan.originalDocument,
          after: plan.expectedDocument,
          beforeHash: plan.originalHash,
          afterHash: plan.expectedHash,
          session,
        });
        changed = 1;
      } else if (currentHash === plan.expectedHash && isV2Marker(current)) {
        fail(
          "A committed v2 target appeared without its transactional pending manifest.",
          "EXPEDIA_V2_MANUAL_INTERVENTION_REQUIRED"
        );
      } else {
        fail(
          "The reservation is neither the approved v1 nor committed v2 EJSON.",
          "EXPEDIA_V2_MANUAL_INTERVENTION_REQUIRED"
        );
      }
      assertPostconditions({
        before: plan.originalDocument,
        after: replacement.document,
        commercial: plan.commercial,
        lineage: plan.lineage,
      });
      const pendingManifest = await stageAppliedManifest(
        db,
        plan,
        backup,
        capability,
        session
      );
      return { replacement, changed, resumed, pendingManifest };
    }
  );
  await completeForwardPostverify(
    db,
    plan,
    { ...backup, manifest: terminal.pendingManifest },
    capability
  );
  return {
    state: "applied",
    changed: terminal.changed,
    resumed: terminal.resumed,
    acknowledgementLost: terminal.replacement.acknowledgementLost,
    backupSetSha256: backup.backupSetSha256,
    vendorApiCalls: 0,
  };
}

async function loadRollbackPlan({
  db,
  releaseSha,
  plannedAt,
  portalSelection,
  execution: executionInput,
}) {
  const execution = normalizeExecutionAttestation(executionInput, releaseSha);
  const proofIssuedAt = exactDate(plannedAt, "rollback proof issue timestamp");
  const backup = await loadAndVerifyBackup(db, portalSelection);
  if (backup.manifest.state === "postverify_failed") {
    fail(
      "The repair is in durable manual-intervention state after failed postverification.",
      "EXPEDIA_V2_MANUAL_INTERVENTION_REQUIRED"
    );
  }
  await verifyImmutableEvidenceAgainstBackup(db, backup);
  const reservationRecord = backup.byRole.get("reservation_before");
  const current = await db
    .collection(COLLECTIONS.reservation)
    .findOne(
      { _id: objectId(TARGET.reservationMongoId) },
      primaryReadOptions()
    );
  if (!current) {
    fail("The exact reservation is missing.", "EXPEDIA_V2_ROLLBACK_BLOCKED");
  }
  const currentHash = canonicalEjsonSha256(current);
  let state = "";
  let resumeState = "";
  if (currentHash === reservationRecord.originalHash) {
    assertExactV1PostState(current, backup.lineage);
    if (backup.manifest.state === "rolled_back") {
      state = "already_rolled_back";
    } else if (backup.manifest.state === "rolled_back_pending_postverify") {
      state = "ready";
      resumeState = "rolled_back_pending_postverify";
    } else if (["applied", "rolling_back"].includes(backup.manifest.state)) {
      fail(
        "A restored v1 target with a nonterminal rollback manifest is not a valid transactional state.",
        "EXPEDIA_V2_MANUAL_INTERVENTION_REQUIRED"
      );
    } else {
      fail(
        "The restored reservation lacks a resumable rollback manifest.",
        "EXPEDIA_V2_ROLLBACK_BLOCKED"
      );
    }
  } else if (currentHash === reservationRecord.expectedRepairedHash) {
    if (!["applied", "rolling_back"].includes(backup.manifest.state)) {
      fail(
        "Rollback lacks an applied or owned rollback manifest.",
        "EXPEDIA_V2_ROLLBACK_BLOCKED"
      );
    }
    state = "ready";
    resumeState =
      backup.manifest.state === "rolling_back"
        ? "rolling_back_before_restore"
        : "applied";
  } else {
    fail(
      "Rollback found neither exact v1 nor exact v2 EJSON.",
      "EXPEDIA_V2_ROLLBACK_BLOCKED"
    );
  }
  if (
    currentHash === reservationRecord.expectedRepairedHash &&
    !isV2Marker(current)
  ) {
    fail(
      "Rollback lacks the exact applied v2 marker.",
      "EXPEDIA_V2_ROLLBACK_BLOCKED"
    );
  }
  const rollbackScopeHash = canonicalEjsonSha256({
    originalHash: reservationRecord.originalHash,
    expectedRepairedHash: reservationRecord.expectedRepairedHash,
    backupSetSha256: backup.backupSetSha256,
    portalJobHash: backup.byRole.get("expedia_portal_job_evidence")
      .originalHash,
    predecessorManifestHash: backup.manifest.predecessorManifestHash,
    predecessorBackupSetSha256: backup.manifest.predecessorBackupSetSha256,
  });
  const proofBasis = {
    version: 2,
    action: "rollback",
    repairId: REPAIR_ID,
    releaseSha: lower(releaseSha),
    proofIssuedAt: proofIssuedAt.toISOString(),
    rollbackScopeHash,
    originalHash: reservationRecord.originalHash,
    expectedRepairedHash: reservationRecord.expectedRepairedHash,
    backupSetSha256: backup.backupSetSha256,
    manifestHash: canonicalEjsonSha256(backup.manifest),
    portalJobHash: backup.byRole.get("expedia_portal_job_evidence")
      .originalHash,
    predecessorManifestHash: backup.manifest.predecessorManifestHash,
    predecessorBackupSetSha256: backup.manifest.predecessorBackupSetSha256,
    executionTreeSha: execution.treeSha,
    executionFingerprint: execution.executionFingerprint,
    vendorApiCalls: 0,
  };
  if (state === "already_rolled_back") {
    await verifyPostcommitState(db, backup, reservationRecord.originalHash);
  }
  return {
    state,
    action: "rollback",
    repairId: REPAIR_ID,
    releaseSha: lower(releaseSha),
    plannedAt: proofIssuedAt,
    proofIssuedAt,
    planHash: canonicalEjsonSha256(proofBasis),
    rollbackScopeHash,
    resumeState,
    execution,
    portalSelection,
    backup,
    manifestHash: canonicalEjsonSha256(backup.manifest),
    currentDocument: current,
    originalDocument: reservationRecord.originalDocument,
    originalHash: reservationRecord.originalHash,
    expectedHash: reservationRecord.expectedRepairedHash,
  };
}

function rollbackAttemptFields(capability, plan, attemptNumber, now) {
  return {
    state: "rolling_back",
    rollbackScopeHash: plan.rollbackScopeHash,
    rollbackPlanHash: plan.planHash,
    rollbackPredecessorManifestHash: plan.manifestHash,
    rollbackOwnerToken: capability.ownerToken,
    rollbackAttemptNumber: attemptNumber,
    rollbackProofIssuedAt: new Date(capability.proofIssuedAt),
    rollbackProofExpiresAt: new Date(capability.proofExpiresAt),
    rollbackLeaseExpiresAt: new Date(
      Math.min(
        now.getTime() + OWNER_LEASE_MS,
        capability.proofExpiresAt.getTime()
      )
    ),
    rollbackReleaseSha: plan.releaseSha,
    rollbackExecutionTreeSha: plan.execution.treeSha,
    rollbackExecutionFingerprint: plan.execution.executionFingerprint,
  };
}

function assertRollbackLease(manifest, capability, plan, now) {
  const leaseExpiresAt = exactDate(
    manifest?.rollbackLeaseExpiresAt,
    "rollback owner lease expiry"
  );
  if (
    !["rolling_back", "rolled_back_pending_postverify", "rolled_back"].includes(
      manifest?.state
    ) ||
    manifest?.rollbackOwnerToken !== capability.ownerToken ||
    manifest?.rollbackPlanHash !== plan.planHash ||
    manifest?.rollbackScopeHash !== plan.rollbackScopeHash ||
    leaseExpiresAt.getTime() < now.getTime() + OWNER_WRITE_SAFETY_MS ||
    leaseExpiresAt.getTime() > capability.proofExpiresAt.getTime()
  ) {
    fail(
      "The rollback owner lease is absent, stolen, or too close to expiry.",
      "EXPEDIA_V2_OWNER_LEASE_INVALID"
    );
  }
  return true;
}

async function claimRollbackManifest(db, plan, capability, manifest) {
  let attemptNumber = 1;
  const now = assertMutationCapability(capability, plan, "rollback");
  if (manifest.state === "rolling_back") {
    const existingLeaseExpiresAt = exactDate(
      manifest.rollbackLeaseExpiresAt,
      "existing rollback owner lease expiry"
    );
    if (
      manifest.rollbackOwnerToken !== capability.ownerToken &&
      existingLeaseExpiresAt.getTime() > now.getTime()
    ) {
      fail(
        "Another rollback execution still owns the unexpired manifest lease.",
        "EXPEDIA_V2_OWNER_LEASE_ACTIVE"
      );
    }
    attemptNumber = Number(manifest.rollbackAttemptNumber) + 1;
  }
  if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1) {
    fail(
      "The rollback attempt counter is invalid.",
      "EXPEDIA_V2_MANIFEST_CONFLICT"
    );
  }
  const claimed = (
    await replaceManifestExactly({
      db,
      before: manifest,
      set: rollbackAttemptFields(capability, plan, attemptNumber, now),
      plan,
      capability,
      action: "rollback",
    })
  ).manifest;
  assertRollbackLease(claimed, capability, plan, now);
  return claimed;
}

async function claimRollbackPendingPostverify(db, plan, capability, backup) {
  let manifest = backup.manifest;
  if (manifest.state !== "rolled_back_pending_postverify") {
    fail(
      "Rollback pending postverification state changed.",
      "EXPEDIA_V2_MANIFEST_CONFLICT"
    );
  }
  const now = assertMutationCapability(capability, plan, "rollback");
  if (manifest.rollbackOwnerToken !== capability.ownerToken) {
    const leaseExpiresAt = exactDate(
      manifest.rollbackLeaseExpiresAt,
      "pending rollback owner lease expiry"
    );
    if (leaseExpiresAt.getTime() > now.getTime()) {
      fail(
        "Another rollback execution still owns pending postverification.",
        "EXPEDIA_V2_OWNER_LEASE_ACTIVE"
      );
    }
    const attemptNumber = Number(manifest.rollbackAttemptNumber) + 1;
    if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 2) {
      fail(
        "The pending rollback attempt counter is invalid.",
        "EXPEDIA_V2_MANIFEST_CONFLICT"
      );
    }
    manifest = (
      await replaceManifestExactly({
        db,
        before: manifest,
        set: {
          ...rollbackAttemptFields(capability, plan, attemptNumber, now),
          state: "rolled_back_pending_postverify",
        },
        plan,
        capability,
        action: "rollback",
      })
    ).manifest;
  }
  assertRollbackLease(manifest, capability, plan, now);
  return { ...backup, manifest };
}

async function reloadBoundRollbackBackup(db, plan, capability) {
  const backup = await loadAndVerifyBackup(db, plan.portalSelection);
  assertRollbackLease(
    backup.manifest,
    capability,
    plan,
    assertMutationCapability(capability, plan, "rollback")
  );
  await verifyImmutableEvidenceAgainstBackup(db, backup);
  return backup;
}

async function stageRolledBackManifest(db, plan, backup, capability, session) {
  const now = assertMutationCapability(capability, plan, "rollback");
  assertRollbackLease(backup.manifest, capability, plan, now);
  return (
    await replaceManifestExactly({
      db,
      before: backup.manifest,
      set: {
        state: "rolled_back_pending_postverify",
        rolledBackPendingAt: now,
        rolledBackReleaseSha: plan.releaseSha,
        rollbackDocumentHash: plan.originalHash,
        postverifyAction: "rollback",
        postverifyStatus: "pending",
        postverifyPendingAt: now,
        vendorApiCalls: 0,
      },
      plan,
      capability,
      action: "rollback",
      session,
    })
  ).manifest;
}

async function completeRollbackPostverify(db, plan, backup, capability) {
  try {
    await verifyPostcommitState(db, backup, plan.originalHash);
  } catch (error) {
    if (error?.code !== "EXPEDIA_V2_PROTECTED_ARTIFACT_DRIFT") throw error;
    await markPostverifyFailed({
      db,
      plan,
      manifest: backup.manifest,
      capability,
      action: "rollback",
      error,
    });
    fail(
      "Rollback postverification detected protected drift; manual intervention is required.",
      "EXPEDIA_V2_MANUAL_INTERVENTION_REQUIRED"
    );
  }
  const verifiedAt = assertMutationCapability(capability, plan, "rollback");
  assertRollbackLease(backup.manifest, capability, plan, verifiedAt);
  const finalized = (
    await replaceManifestExactly({
      db,
      before: backup.manifest,
      set: {
        state: "rolled_back",
        rolledBackAt: verifiedAt,
        postverifyStatus: "verified",
        postverifiedAt: verifiedAt,
        vendorApiCalls: 0,
      },
      plan,
      capability,
      action: "rollback",
    })
  ).manifest;
  return finalized;
}

async function applyRollbackPlan({ db, plan, capability }) {
  if (plan.state === "already_rolled_back") {
    return {
      state: "already_rolled_back",
      changed: 0,
      backupSetSha256: plan.backup.backupSetSha256,
      vendorApiCalls: 0,
    };
  }
  if (plan.state !== "ready") {
    fail(
      "Only an exact ready rollback can be applied.",
      "EXPEDIA_V2_ROLLBACK_BLOCKED"
    );
  }
  assertMutationCapability(capability, plan, "rollback");
  await v1.assertWritablePrimary(db);
  const transactionClient = await requireTransactionClient(db);
  const currentBackup = await loadAndVerifyBackup(db, plan.portalSelection);
  if (canonicalEjsonSha256(currentBackup.manifest) !== plan.manifestHash) {
    fail(
      "The v2 manifest changed after rollback dry run.",
      "EXPEDIA_V2_PROOF_MISMATCH"
    );
  }
  await verifyImmutableEvidenceAgainstBackup(db, currentBackup);
  if (plan.resumeState === "rolled_back_pending_postverify") {
    const pendingBackup = await claimRollbackPendingPostverify(
      db,
      plan,
      capability,
      currentBackup
    );
    await completeRollbackPostverify(db, plan, pendingBackup, capability);
    return {
      state: "rolled_back",
      changed: 0,
      resumed: true,
      acknowledgementLost: false,
      backupSetSha256: pendingBackup.backupSetSha256,
      vendorApiCalls: 0,
    };
  }
  await claimRollbackManifest(db, plan, capability, currentBackup.manifest);
  const ownedBackup = await reloadBoundRollbackBackup(db, plan, capability);
  const terminal = await runTerminalTransaction(
    transactionClient,
    async (session) => {
      await verifyTerminalImmutableInputs(db, ownedBackup, session);
      const current = await db
        .collection(COLLECTIONS.reservation)
        .findOne(
          { _id: objectId(TARGET.reservationMongoId) },
          primaryReadOptions(session)
        );
      const currentHash = current ? canonicalEjsonSha256(current) : "";
      let replacement;
      let changed = 0;
      let resumed = false;
      if (currentHash === plan.expectedHash) {
        const mutationNow = assertMutationCapability(
          capability,
          plan,
          "rollback"
        );
        assertRollbackLease(
          ownedBackup.manifest,
          capability,
          plan,
          mutationNow
        );
        replacement = await replaceWithHashReadback({
          collection: db.collection(COLLECTIONS.reservation),
          before: plan.currentDocument,
          after: plan.originalDocument,
          beforeHash: plan.expectedHash,
          afterHash: plan.originalHash,
          session,
        });
        changed = 1;
      } else if (currentHash === plan.originalHash) {
        fail(
          "An exact restored v1 target appeared without its transactional pending manifest.",
          "EXPEDIA_V2_MANUAL_INTERVENTION_REQUIRED"
        );
      } else {
        fail(
          "Rollback found neither exact v2 nor exact restored v1 EJSON at write time.",
          "EXPEDIA_V2_ROLLBACK_BLOCKED"
        );
      }
      if (
        canonicalEjsonSha256(replacement.document) !== plan.originalHash ||
        clean(
          replacement.document?.supplierData?.otaCommercialRepair?.repairId
        ) !== v1.REPAIR_ID ||
        isV2Marker(replacement.document)
      ) {
        fail(
          "Rollback did not restore exact v1 EJSON.",
          "EXPEDIA_V2_ROLLBACK_BLOCKED"
        );
      }
      assertExactV1PostState(replacement.document, ownedBackup.lineage);
      const pendingManifest = await stageRolledBackManifest(
        db,
        plan,
        ownedBackup,
        capability,
        session
      );
      return { replacement, changed, resumed, pendingManifest };
    }
  );
  await completeRollbackPostverify(
    db,
    plan,
    { ...ownedBackup, manifest: terminal.pendingManifest },
    capability
  );
  return {
    state: "rolled_back",
    changed: terminal.changed,
    resumed: terminal.resumed,
    acknowledgementLost: terminal.replacement.acknowledgementLost,
    backupSetSha256: plan.backup.backupSetSha256,
    vendorApiCalls: 0,
  };
}

function sanitizedDailyAllocation(plan) {
  const document =
    plan.expectedDocument ||
    (plan.state === "already_applied" ? plan.scope?.reservation : null);
  const days = (
    Array.isArray(document?.pickedRoomsPricing)
      ? document.pickedRoomsPricing
      : []
  ).flatMap((room) =>
    Array.isArray(room?.pricingByDay) ? room.pricingByDay : []
  );
  return days.map((day) => ({
    guestGross: day.clientPrice,
    hotelPayout: day.netAfterExpenses,
    hotelRoot: day.rootPrice,
    deduction: day.otaExpenseAmount,
    margin: day.platformMargin,
  }));
}

function sanitizedForwardOutput(plan, mode, proof = "") {
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
    reservationCountByPmsConfirmation: 1,
    reservationCountByProviderConfirmation: 1,
    identitiesConvergeOnOneReservation: true,
    hotelRunnerEventCount: 1,
    hotelRunnerMirrorCount: 1,
    provider: "expedia",
    channel: "expedia",
    scopeFingerprint: sha256(
      plan.originalHash + ":" + (plan.commercial?.sourceJobHash || "")
    ),
    portalEvidenceHash:
      plan.commercial?.sourceJobHash ||
      plan.backup?.byRole?.get("expedia_portal_job_evidence")?.originalHash,
    commercialEvidenceHash: plan.commercial?.evidence?.evidenceHash,
    conversionEvidenceHash: plan.commercial?.conversionHash,
    commercial: plan.commercial
      ? {
          sourceCurrency: TARGET.sourceCurrency,
          propertyCurrency: TARGET.propertyCurrency,
          sourceGuestGross: TARGET.portalGuestGross,
          sourceHotelPayout: TARGET.hotelRunnerReportedAmount,
          trustedRate: plan.commercial.conversion.rate,
          propertyGuestGross: plan.commercial.gross,
          propertyHotelPayout: plan.commercial.payout,
          propertyDeduction: plan.commercial.deduction,
          propertyHotelBase: TARGET.rootTotal,
          propertyMargin: plan.commercial.margin,
          pmsCommission: 0,
          explicitOtaCommission: null,
        }
      : undefined,
    dailyCommercialReconciliation: sanitizedDailyAllocation(plan),
    predecessorManifestHash:
      plan.lineage?.manifestHash ||
      plan.backup?.manifest?.predecessorManifestHash,
    predecessorBackupSetSha256:
      plan.lineage?.backup?.backupSetSha256 ||
      plan.backup?.manifest?.predecessorBackupSetSha256,
    backupSetSha256: plan.backup?.backupSetSha256,
    executionTreeSha: plan.execution?.treeSha,
    executionFingerprint: plan.execution?.executionFingerprint,
    trackedWorktreeClean: plan.execution?.trackedWorktreeClean === true,
    fullDocumentCas: true,
    createsReservations: false,
    mutatesLifecycleGuestStayRoomAssignmentPaymentVccSettlementOrRoot: false,
    mutatesHotelRunnerEventMirrorPortalJobOrV1Artifacts: false,
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
    proof:
      mode === "rollback_dry_run" && plan.state === "ready" ? proof : undefined,
    proofExpiresInMinutes:
      mode === "rollback_dry_run" && plan.state === "ready"
        ? PROOF_MAX_AGE_MS / 60_000
        : undefined,
    planHash: plan.planHash,
    fromHash: plan.expectedHash,
    toV1BackupHash: plan.originalHash,
    backupSetSha256: plan.backup.backupSetSha256,
    predecessorManifestHash: plan.backup.manifest.predecessorManifestHash,
    executionTreeSha: plan.execution?.treeSha,
    executionFingerprint: plan.execution?.executionFingerprint,
    trackedWorktreeClean: plan.execution?.trackedWorktreeClean === true,
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

async function runMainWithDependencies(
  argv = process.argv.slice(2),
  {
    clock = () => new Date(),
    connect = connectDatabase,
    disconnect = async () => mongoose.disconnect(),
    resolveReleaseSha = v1.currentReleaseSha,
    executionAttestor = attestExecutionCheckout,
    db: injectedDb = null,
  } = {}
) {
  const options = parseArguments(argv);
  const portalSelection = portalSelectionFromArguments(options);
  v1.assertRelease(options.releaseSha, resolveReleaseSha());
  const now = clock();
  const proofDetails = options.apply ? parseProof(options.proof, now) : null;
  const plannedAt = proofDetails?.plannedAt || now;
  const execution = assertCleanExecution(
    executionAttestor({ releaseSha: options.releaseSha }),
    options.releaseSha
  );
  const database =
    process.env.DATABASE || process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!database && !injectedDb) {
    fail("Missing database connection string.", "EXPEDIA_V2_DATABASE_REQUIRED");
  }
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
        execution,
      });
      const generatedProof = rollbackProofToken(plan);
      if (
        options.apply &&
        (proofDetails.planHash !== plan.planHash ||
          options.proof !== generatedProof)
      ) {
        fail(
          "Rollback scope no longer matches its proof.",
          "EXPEDIA_V2_PROOF_MISMATCH"
        );
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
      if (!options.apply) {
        const output = sanitizedRollbackOutput(
          plan,
          "rollback_dry_run",
          generatedProof
        );
        return {
          ...output,
          state:
            plan.state === "already_rolled_back"
              ? "already_rolled_back"
              : "rollback_dry_run_ready",
        };
      }
      const writeExecution = assertCleanExecution(
        executionAttestor({ releaseSha: options.releaseSha }),
        options.releaseSha
      );
      if (
        writeExecution.treeSha !== execution.treeSha ||
        writeExecution.executionFingerprint !== execution.executionFingerprint
      ) {
        fail(
          "The executing tree changed after rollback planning.",
          "EXPEDIA_V2_EXECUTION_ATTESTATION_INVALID"
        );
      }
      const capability = createMutationCapability({
        action: "rollback",
        plan,
        proofDetails,
        execution: writeExecution,
        clock,
      });
      const result = await applyRollbackPlan({ db, plan, capability });
      console.log(JSON.stringify(result, null, 2));
      return result;
    }
    const plan = await loadPlan({
      db,
      releaseSha: options.releaseSha,
      plannedAt,
      portalSelection,
      execution,
    });
    if (plan.state === "already_applied") {
      const output = sanitizedForwardOutput(plan, "already_applied");
      console.log(JSON.stringify(output, null, 2));
      return { ...output, changed: 0 };
    }
    const generatedProof = proofToken(plan);
    if (
      options.apply &&
      (proofDetails.planHash !== plan.planHash ||
        options.proof !== generatedProof)
    ) {
      fail(
        "The exact scope no longer matches the supplied proof.",
        "EXPEDIA_V2_PROOF_MISMATCH"
      );
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
    if (!options.apply) {
      return {
        ...sanitizedForwardOutput(plan, "dry_run", generatedProof),
        state: "dry_run_ready",
      };
    }
    const writeExecution = assertCleanExecution(
      executionAttestor({ releaseSha: options.releaseSha }),
      options.releaseSha
    );
    if (
      writeExecution.treeSha !== execution.treeSha ||
      writeExecution.executionFingerprint !== execution.executionFingerprint
    ) {
      fail(
        "The executing tree changed after forward planning.",
        "EXPEDIA_V2_EXECUTION_ATTESTATION_INVALID"
      );
    }
    const capability = createMutationCapability({
      action: "forward",
      plan,
      proofDetails,
      execution: writeExecution,
      clock,
    });
    const result = await applyRepairPlan({ db, plan, capability });
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    if (connectedHere) await disconnect();
  }
}

async function main(...args) {
  if (args.length > 1) {
    fail(
      "The production entrypoint does not accept injected dependencies.",
      "EXPEDIA_V2_DEPENDENCY_INJECTION_BLOCKED"
    );
  }
  return runMainWithDependencies(args[0] || process.argv.slice(2), {
    clock: () => new Date(),
    connect: connectDatabase,
    disconnect: async () => mongoose.disconnect(),
    resolveReleaseSha: v1.currentReleaseSha,
    executionAttestor: attestExecutionCheckout,
    db: null,
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error("[expedia-commercial-materialization-v2] stopped", {
      code: clean(error?.code || "EXPEDIA_V2_REPAIR_FAILED").slice(0, 100),
    });
    process.exitCode = 1;
  });
}

module.exports = {
  BACKUP_COLLECTION,
  BACKUP_ROLES,
  COLLECTIONS,
  COLLECTOR_MAX_AGE_MS,
  MANIFEST_COLLECTION,
  PROOF_MAX_AGE_MS,
  REPAIR_ID,
  TARGET,
  allocateCentsByWeight,
  applyRepairPlan,
  applyRollbackPlan,
  assertExactV1PostState,
  assertFreshPortalEvidence,
  assertOperationallySafe,
  assertPostconditions,
  assertTrustedConversion,
  backupRecord,
  buildBackupRecords,
  buildCommercialEvidence,
  buildExpectedDocument,
  buildWeightedPricing,
  loadAndVerifyBackup,
  loadPlan,
  loadRawScope,
  loadRollbackPlan,
  loadV1Lineage,
  main,
  materializedPaymentSummary,
  parseArguments,
  parseProof,
  portalSelectionFromArguments,
  proofToken,
  protectedSnapshot,
  rollbackProofToken,
  sanitizedForwardOutput,
  sanitizedRollbackOutput,
  sourceSlots,
  verifyBackupRecords,
};
