/**
 * Repair exactly one OTA pricing-save incident discovered on 2026-08-05.
 *
 * Dry run (default, no writes):
 *   node scripts/repairOtaPricingSaveIncident20260805.js
 *
 * Apply:
 *   node scripts/repairOtaPricingSaveIncident20260805.js \
 *     --apply --repair-id ota-pricing-20260805-<change-id> \
 *     --repair-at 2026-08-05T18:00:00.000Z
 *
 * Rollback dry run / apply:
 *   node scripts/repairOtaPricingSaveIncident20260805.js \
 *     --rollback --repair-id ota-pricing-20260805-<change-id>
 *   node scripts/repairOtaPricingSaveIncident20260805.js \
 *     --rollback --apply --repair-id ota-pricing-20260805-<change-id>
 *
 * The script never retries a reservation write. A bounded primary/majority
 * readback resolves a lost write acknowledgement. The full raw reservation
 * backup and its ownership manifest are retained permanently.
 */

"use strict";

require("dotenv").config();

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const mongoose = require("mongoose");

mongoose.set("strictQuery", true);
mongoose.set("autoCreate", false);

const Reservations = require("../models/reservations");
const {
  MANIFEST_COLLECTION,
  OPERATION,
  TARGET,
  buildBackupCollectionName,
  buildRepairPlan,
  buildStrictExactCasFilter,
  validateCurrentReservation,
  validateRepairId,
  verifyRepairedDocument,
} = require("../services/otaPricingSaveIncidentRepair20260805");
const {
  canonicalEjsonSha256,
  canonicalEqual,
  cloneBson,
} = require("../services/tripHotelRunnerRepair20260805");

const RESERVATION_COLLECTION = "reservations";
const BACKUP_RECORD_ID = `${RESERVATION_COLLECTION}:${TARGET.mongoId}`;
const PRIMARY_MAJORITY_READ = Object.freeze({
  readPreference: "primary",
  readConcern: Object.freeze({ level: "majority" }),
});
const MAJORITY_WRITE = Object.freeze({
  writeConcern: Object.freeze({ w: "majority" }),
});

const usage = () =>
  [
    "Usage:",
    "  node scripts/repairOtaPricingSaveIncident20260805.js [--repair-id <id>] [--repair-at <canonical-ISO>]",
    "  node scripts/repairOtaPricingSaveIncident20260805.js --apply --repair-id <id> --repair-at <canonical-ISO>",
    "  node scripts/repairOtaPricingSaveIncident20260805.js --rollback --repair-id <id>",
    "  node scripts/repairOtaPricingSaveIncident20260805.js --rollback --apply --repair-id <id>",
    "",
    "A repair write requires --apply, an explicit unique --repair-id, and the exact --repair-at emitted by dry run.",
    "Run dry-run with the same explicit repair ID before apply; both values determine every planned hash.",
    "Stop hotels-backend before applying or rolling back.",
    `Fixed scope: OTA ${TARGET.otaConfirmation} / PMS ${TARGET.pmsConfirmation} / Mongo ${TARGET.mongoId}.`,
  ].join("\n");

const validateRepairAt = (value) => {
  const repairAt = String(value || "").trim();
  assert.ok(repairAt, "--repair-at requires a value.");
  const parsed = new Date(repairAt);
  assert.ok(
    !Number.isNaN(parsed.getTime()),
    "--repair-at must be a valid timestamp."
  );
  assert.equal(
    repairAt,
    parsed.toISOString(),
    "--repair-at must be an exact canonical ISO timestamp (for example 2026-08-05T18:00:00.000Z)."
  );
  assert.ok(
    parsed.getTime() > new Date(TARGET.updatedAt).getTime(),
    `--repair-at must be later than the incident document timestamp ${TARGET.updatedAt}.`
  );
  return repairAt;
};

const parseArguments = (argv = []) => {
  const args = {
    apply: false,
    rollback: false,
    repairId: "",
    repairAt: "",
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--apply") args.apply = true;
    else if (token === "--rollback") args.rollback = true;
    else if (token === "--help" || token === "-h") args.help = true;
    else if (token === "--repair-id") {
      assert.ok(argv[index + 1], "--repair-id requires a value.");
      assert.equal(args.repairId, "", "--repair-id may be supplied only once.");
      args.repairId = validateRepairId(argv[index + 1]);
      index += 1;
    } else if (token === "--repair-at") {
      assert.ok(argv[index + 1], "--repair-at requires a value.");
      assert.equal(args.repairAt, "", "--repair-at may be supplied only once.");
      args.repairAt = validateRepairAt(argv[index + 1]);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  if (args.rollback) {
    assert.ok(
      args.repairId,
      "--rollback requires --repair-id, including for rollback dry runs."
    );
    assert.equal(
      args.repairAt,
      "",
      "--rollback derives the repair timestamp from its permanent manifest; do not supply --repair-at."
    );
  } else {
    assert.ok(
      !args.repairAt || args.repairId,
      "--repair-at requires the explicit --repair-id used for this plan."
    );
    if (args.apply) {
      assert.ok(args.repairId, "--apply requires an explicit --repair-id.");
      assert.ok(
        args.repairAt,
        "--apply requires the exact --repair-at emitted by the dry run."
      );
    }
  }
  return args;
};

const objectId = (value) => new mongoose.Types.ObjectId(String(value));
const readOptions = (extra = {}) => ({
  readPreference: PRIMARY_MAJORITY_READ.readPreference,
  readConcern: { ...PRIMARY_MAJORITY_READ.readConcern },
  ...extra,
});
const writeOptions = (extra = {}) => ({
  writeConcern: { ...MAJORITY_WRITE.writeConcern },
  ...extra,
});

const targetQuery = () => ({ _id: objectId(TARGET.mongoId) });

const readTargetReservation = async ({ reservationCollection }) =>
  reservationCollection.findOne(targetQuery(), readOptions());

const loadCurrentReservation = async ({ reservationCollection }) => {
  const reservation = await readTargetReservation({ reservationCollection });
  validateCurrentReservation(reservation);
  return reservation;
};

const readReservationAfterWrite = async ({
  reservationCollection,
  maxAttempts = 3,
}) => {
  assert.ok(
    Number.isInteger(maxAttempts) && maxAttempts >= 1 && maxAttempts <= 3,
    "Write readback attempts must stay bounded between one and three."
  );
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await readTargetReservation({ reservationCollection });
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `Could not resolve the reservation write using ${maxAttempts} primary/majority reads: ${
      lastError?.message || "unknown read error"
    }`
  );
};

const executeWriteWithHashReadback = async ({
  reservationCollection,
  write,
  beforeHash,
  afterHash,
  validateAcknowledgement = () => {},
}) => {
  let acknowledgementError = null;
  try {
    const acknowledgement = await write();
    validateAcknowledgement(acknowledgement);
  } catch (error) {
    acknowledgementError = error;
  }

  const document = await readReservationAfterWrite({ reservationCollection });
  assert.ok(
    document,
    "The exact target reservation disappeared during the write."
  );
  const observedHash = canonicalEjsonSha256(document);
  if (observedHash === afterHash) {
    return {
      document,
      observedHash,
      state: "after",
      acknowledgementLost: Boolean(acknowledgementError),
      acknowledgementError: acknowledgementError?.message || "",
    };
  }
  if (observedHash === beforeHash) {
    const error = new Error(
      acknowledgementError
        ? `The one permitted write did not commit: ${acknowledgementError.message}`
        : "The write acknowledgement did not produce the exact planned document."
    );
    error.writeResolution = "before";
    error.observedHash = observedHash;
    throw error;
  }
  const error = new Error(
    `The write outcome is unsafe: live hash ${observedHash} is neither the exact before nor exact after hash. No write retry is permitted.`
  );
  error.writeResolution = "unexpected";
  error.observedHash = observedHash;
  error.acknowledgementError = acknowledgementError?.message || "";
  throw error;
};

const validateDeterministicContext = (context) => {
  assert.ok(
    context && typeof context === "object",
    "Repair context is required."
  );
  const repairId = validateRepairId(context.repairId);
  assert.equal(
    context.backupCollection,
    buildBackupCollectionName(repairId),
    "Repair context backup collection mismatch."
  );
  const repairAt = new Date(context.repairAt);
  const backupAt = new Date(context.backupAt);
  assert.ok(
    !Number.isNaN(repairAt.getTime()),
    "Repair context timestamp is invalid."
  );
  assert.ok(
    !Number.isNaN(backupAt.getTime()),
    "Backup context timestamp is invalid."
  );
  assert.equal(
    backupAt.toISOString(),
    repairAt.toISOString(),
    "Backup and repair timestamps must be identical so the dry-run envelope is deterministic."
  );
  return { repairId, repairAt, backupAt };
};

const backupRecordCore = ({ plan, context }) => {
  const { repairId, backupAt } = validateDeterministicContext(context);
  return {
    _id: BACKUP_RECORD_ID,
    repairId,
    operation: OPERATION,
    backupCollection: context.backupCollection,
    backupAt,
    sourceCollection: RESERVATION_COLLECTION,
    originalId: plan.originalDocument._id,
    originalHash: plan.originalHash,
    expectedRepairedHash: plan.expectedHash,
    casFilterHash: plan.casFilterHash,
    originalDocument: cloneBson(plan.originalDocument),
  };
};

const buildBackupRecord = ({ plan, context }) => {
  const core = backupRecordCore({ plan, context });
  return {
    ...core,
    recordHash: canonicalEjsonSha256(core),
  };
};

const verifyBackupRecord = ({ record, context, manifest = null }) => {
  assert.ok(record, "The permanent reservation backup is missing.");
  assert.equal(
    String(record._id || ""),
    BACKUP_RECORD_ID,
    "Backup record scope changed."
  );
  assert.equal(
    String(record.repairId || ""),
    context.repairId,
    "Backup repair ID changed."
  );
  assert.equal(record.operation, OPERATION, "Backup operation changed.");
  assert.equal(
    record.sourceCollection,
    RESERVATION_COLLECTION,
    "Backup source collection changed."
  );
  assert.equal(
    String(record.backupCollection || ""),
    context.backupCollection,
    "Backup collection marker changed."
  );
  const { backupAt } = validateDeterministicContext(context);
  assert.ok(
    canonicalEqual(record.backupAt, backupAt),
    "Backup timestamp differs from the deterministic repair plan."
  );
  assert.equal(
    String(record.originalId || ""),
    TARGET.mongoId,
    "Backup embedded target ID changed."
  );
  assert.equal(
    String(record.originalDocument?._id || ""),
    TARGET.mongoId,
    "Backup raw reservation ID changed."
  );
  assert.equal(
    canonicalEjsonSha256(record.originalDocument),
    record.originalHash,
    "Backup raw reservation hash mismatch."
  );
  const core = cloneBson(record);
  delete core.recordHash;
  assert.equal(
    canonicalEjsonSha256(core),
    record.recordHash,
    "Backup envelope hash mismatch."
  );
  for (const [label, value] of Object.entries({
    originalHash: record.originalHash,
    expectedRepairedHash: record.expectedRepairedHash,
    casFilterHash: record.casFilterHash,
    recordHash: record.recordHash,
  })) {
    assert.match(
      String(value || ""),
      /^[a-f0-9]{64}$/,
      `Backup ${label} is invalid.`
    );
  }
  if (manifest) {
    assert.ok(
      canonicalEqual(manifest.repairAt, context.repairAt),
      "Manifest repair timestamp mismatch."
    );
    assert.ok(
      canonicalEqual(manifest.backupAt, context.backupAt),
      "Manifest backup timestamp mismatch."
    );
    assert.equal(
      record.originalHash,
      manifest.originalHash,
      "Manifest original hash mismatch."
    );
    assert.equal(
      record.expectedRepairedHash,
      manifest.expectedRepairedHash,
      "Manifest repaired hash mismatch."
    );
    assert.equal(
      record.casFilterHash,
      manifest.casFilterHash,
      "Manifest CAS hash mismatch."
    );
    assert.equal(
      record.recordHash,
      manifest.backupRecordHash,
      "Manifest backup hash mismatch."
    );
  }
  return true;
};

const manifestIdentity = ({ context, plan, backupRecord }) => {
  const { repairId, repairAt, backupAt } =
    validateDeterministicContext(context);
  return {
    _id: repairId,
    operation: OPERATION,
    targetMongoId: TARGET.mongoId,
    backupCollection: context.backupCollection,
    repairAt,
    backupAt,
    originalHash: plan.originalHash,
    expectedRepairedHash: plan.expectedHash,
    casFilterHash: plan.casFilterHash,
    backupRecordHash: backupRecord.recordHash,
  };
};

const matchesManifestIdentity = (manifest, identity) =>
  Boolean(manifest) &&
  Object.entries(identity).every(([key, value]) =>
    canonicalEqual(manifest?.[key], value)
  );

const readManifest = ({ manifestCollection, repairId, projection }) =>
  manifestCollection.findOne(
    { _id: repairId },
    readOptions(projection ? { projection } : {})
  );

const assertManifestFence = async ({
  manifestCollection,
  identity,
  state,
  token,
  tokenField,
}) => {
  const manifest = await readManifest({
    manifestCollection,
    repairId: identity._id,
  });
  assert.ok(manifest, `Manifest ${identity._id} disappeared.`);
  assert.ok(
    matchesManifestIdentity(manifest, identity),
    "Manifest identity/hash fence changed."
  );
  assert.equal(
    manifest.state,
    state,
    `Manifest is not in fenced state ${state}.`
  );
  assert.equal(
    manifest[tokenField],
    token,
    `Manifest ${tokenField} ownership was lost.`
  );
  return manifest;
};

const transitionManifest = async ({
  manifestCollection,
  identity,
  fromState,
  toState,
  token,
  tokenField,
  set = {},
}) => {
  const filter = {
    ...identity,
    state: fromState,
    [tokenField]: token,
  };
  let acknowledgementError = null;
  try {
    const result = await manifestCollection.updateOne(
      filter,
      { $set: { state: toState, updatedAt: new Date(), ...set } },
      writeOptions()
    );
    assert.equal(
      result.matchedCount,
      1,
      `Manifest transition ${fromState}->${toState} lost its fence.`
    );
    assert.equal(
      result.modifiedCount,
      1,
      `Manifest transition ${fromState}->${toState} did not write.`
    );
  } catch (error) {
    acknowledgementError = error;
  }
  const observed = await readManifest({
    manifestCollection,
    repairId: identity._id,
  });
  if (
    matchesManifestIdentity(observed, identity) &&
    observed?.state === toState &&
    observed?.[tokenField] === token &&
    Object.entries(set).every(([key, value]) =>
      canonicalEqual(observed?.[key], value)
    )
  ) {
    return {
      manifest: observed,
      acknowledgementLost: Boolean(acknowledgementError),
    };
  }
  if (
    acknowledgementError &&
    matchesManifestIdentity(observed, identity) &&
    observed?.state === fromState &&
    observed?.[tokenField] === token
  ) {
    throw new Error(
      `Manifest transition ${fromState}->${toState} did not commit: ${acknowledgementError.message}`
    );
  }
  throw new Error(
    `Manifest transition ${fromState}->${toState} has an unsafe or unfenced outcome: ${
      acknowledgementError?.message || "readback mismatch"
    }`
  );
};

const claimNewRepair = async ({
  manifestCollection,
  context,
  plan,
  backupRecord,
  tokenFactory = () => crypto.randomBytes(24).toString("hex"),
}) => {
  const applyToken = String(tokenFactory());
  assert.ok(applyToken, "Apply ownership token is empty.");
  const identity = manifestIdentity({ context, plan, backupRecord });
  const manifest = {
    ...identity,
    state: "initializing",
    applyToken,
    target: cloneBson(TARGET),
    createdAt: new Date(context.repairAt),
    updatedAt: new Date(context.repairAt),
  };
  let acknowledgementError = null;
  try {
    await manifestCollection.insertOne(manifest, writeOptions());
  } catch (error) {
    acknowledgementError = error;
  }
  const observed = await readManifest({
    manifestCollection,
    repairId: context.repairId,
  });
  if (observed && canonicalEqual(observed, manifest)) {
    return {
      applyToken,
      identity,
      manifest: observed,
      acknowledgementLost: Boolean(acknowledgementError),
    };
  }
  if (observed) {
    throw new Error(
      `Repair ID ${context.repairId} already exists or no longer matches this exact plan; repair IDs are never reused or taken over.`
    );
  }
  throw (
    acknowledgementError ||
    new Error("Repair manifest insert was not visible after write.")
  );
};

const listBackupRecords = async ({ backupCollection }) =>
  backupCollection.find({}, readOptions()).sort({ _id: 1 }).toArray();

const createAndVerifyBackup = async ({ db, record, context }) => {
  const before = await db
    .listCollections({ name: context.backupCollection }, { nameOnly: true })
    .toArray();
  assert.equal(
    before.length,
    0,
    "Backup collection already exists; refusing to reuse it."
  );
  let createError = null;
  try {
    await db.createCollection(context.backupCollection, writeOptions());
  } catch (error) {
    createError = error;
  }
  const afterCreate = await db
    .listCollections({ name: context.backupCollection }, { nameOnly: true })
    .toArray();
  if (afterCreate.length !== 1)
    throw createError || new Error("Backup collection was not created.");
  const backupCollection = db.collection(context.backupCollection);
  const existingRecords = await listBackupRecords({ backupCollection });
  assert.equal(
    existingRecords.length,
    0,
    "New backup collection is not empty; no backup write is allowed."
  );
  let insertError = null;
  try {
    await backupCollection.insertOne(record, writeOptions());
  } catch (error) {
    insertError = error;
  }
  const readback = await listBackupRecords({ backupCollection });
  if (readback.length !== 1) {
    throw (
      insertError || new Error("Permanent backup was not written exactly once.")
    );
  }
  verifyBackupRecord({ record: readback[0], context });
  assert.ok(
    canonicalEqual(readback[0], record),
    "Permanent backup differs from the planned full raw backup."
  );
  return readback[0];
};

const dryRunReport = ({ plan, context, explicitRepairId = false }) => {
  const repairAt = new Date(context.repairAt).toISOString();
  const backupRecord = buildBackupRecord({ plan, context });
  const baseCommand = "node scripts/repairOtaPricingSaveIncident20260805.js";
  const planCommand = `${baseCommand} --repair-id ${context.repairId} --repair-at ${repairAt}`;
  const applyCommand = `${baseCommand} --apply --repair-id ${context.repairId} --repair-at ${repairAt}`;
  return {
    ok: true,
    mode: "dry-run",
    action: "repair",
    writesPerformed: false,
    repairId: context.repairId,
    repairAt,
    backupAt: new Date(context.backupAt).toISOString(),
    backupCollection: context.backupCollection,
    reusableForApply: explicitRepairId,
    scope: {
      reservationMongoId: TARGET.mongoId,
      pmsConfirmation: TARGET.pmsConfirmation,
      otaConfirmation: TARGET.otaConfirmation,
    },
    evidence: {
      originalHash: plan.originalHash,
      casFilterHash: plan.casFilterHash,
      expectedRepairedHash: plan.expectedHash,
      backupRecordHash: backupRecord.recordHash,
    },
    changes: plan.diff,
    preserved: [
      "full guest, supplier, hotel, payment, room identity, stay, and nightly pricing data",
      "SAR 768.35 client total, SAR 825 hotel base, and SAR 475.42 net total",
      "both original pricing incident audit entries and the lifecycle incident evidence",
      "OTA review remains pending and unreleased",
    ],
    safety: {
      backup:
        "one permanent full raw reservation document plus independent canonical EJSON SHA-256 hashes in the manifest",
      cas: "full original document equality plus exact top-level field count",
      writes:
        "no reservation write retry; lost acknowledgement is classified by bounded primary/majority hash readback",
      rollback:
        "permitted only while the live reservation equals the exact repaired hash",
    },
    interlock:
      "The apply hash is reusable only with this same repair ID and exact canonical repair-at timestamp.",
    exactPlanCommand: planCommand,
    exactApplyCommand: explicitRepairId ? applyCommand : null,
    nextStep: explicitRepairId
      ? `Stop hotels-backend, review this exact plan, then run exactly: ${applyCommand}`
      : `Choose a unique repair ID, then rerun dry-run explicitly before apply: ${baseCommand} --repair-id <unique-repair-id> --repair-at ${repairAt}`,
  };
};

const successfulApplyReport = ({
  context,
  plan,
  writeResolution,
  manifestAcknowledgementRecovered = false,
}) => ({
  ok: true,
  mode: "apply",
  writesPerformed: true,
  repairId: context.repairId,
  backupCollection: context.backupCollection,
  reservationMongoId: TARGET.mongoId,
  pmsConfirmation: TARGET.pmsConfirmation,
  otaConfirmation: TARGET.otaConfirmation,
  originalHash: plan.originalHash,
  repairedHash: plan.expectedHash,
  writeAcknowledgementRecovered: writeResolution?.acknowledgementLost === true,
  manifestAcknowledgementRecovered,
});

const markFailedNoChange = async ({
  manifestCollection,
  identity,
  applyToken,
  cause,
}) => {
  const manifest = await readManifest({
    manifestCollection,
    repairId: identity._id,
  });
  if (
    !matchesManifestIdentity(manifest, identity) ||
    manifest?.applyToken !== applyToken ||
    !["initializing", "backed_up", "applying"].includes(manifest?.state)
  ) {
    return false;
  }
  await transitionManifest({
    manifestCollection,
    identity,
    fromState: manifest.state,
    toState: "failed_no_change",
    token: applyToken,
    tokenField: "applyToken",
    set: {
      failedAt: new Date(),
      failure: String(cause?.message || cause).slice(0, 1000),
      verifiedOriginalHash: identity.originalHash,
    },
  });
  return true;
};

const applyRepair = async ({
  db,
  reservationCollection,
  manifestCollection,
  plan,
  context,
  tokenFactory,
}) => {
  const backupRecord = buildBackupRecord({ plan, context });
  const claim = await claimNewRepair({
    manifestCollection,
    context,
    plan,
    backupRecord,
    tokenFactory,
  });
  const { applyToken, identity } = claim;
  let writeResolution = null;
  let manifestAcknowledgementRecovered = claim.acknowledgementLost;
  try {
    await assertManifestFence({
      manifestCollection,
      identity,
      state: "initializing",
      token: applyToken,
      tokenField: "applyToken",
    });
    const savedBackup = await createAndVerifyBackup({
      db,
      record: backupRecord,
      context,
    });
    verifyBackupRecord({
      record: savedBackup,
      context,
      manifest: claim.manifest,
    });
    const backupTransition = await transitionManifest({
      manifestCollection,
      identity,
      fromState: "initializing",
      toState: "backed_up",
      token: applyToken,
      tokenField: "applyToken",
      set: {
        backedUpAt: new Date(context.backupAt),
        verifiedBackupRecordHash: backupRecord.recordHash,
      },
    });
    manifestAcknowledgementRecovered ||= backupTransition.acknowledgementLost;

    const fresh = await loadCurrentReservation({ reservationCollection });
    assert.equal(
      canonicalEjsonSha256(fresh),
      plan.originalHash,
      "Target reservation changed after planning and backup; repair is blocked."
    );
    const applyingTransition = await transitionManifest({
      manifestCollection,
      identity,
      fromState: "backed_up",
      toState: "applying",
      token: applyToken,
      tokenField: "applyToken",
      set: { applyingAt: new Date() },
    });
    manifestAcknowledgementRecovered ||= applyingTransition.acknowledgementLost;
    await assertManifestFence({
      manifestCollection,
      identity,
      state: "applying",
      token: applyToken,
      tokenField: "applyToken",
    });

    writeResolution = await executeWriteWithHashReadback({
      reservationCollection,
      write: () =>
        reservationCollection.replaceOne(
          plan.casFilter,
          cloneBson(plan.expectedDocument),
          writeOptions()
        ),
      beforeHash: plan.originalHash,
      afterHash: plan.expectedHash,
      validateAcknowledgement: (result) => {
        assert.equal(
          result.matchedCount,
          1,
          "Full-document CAS did not match."
        );
        assert.equal(
          result.modifiedCount,
          1,
          "Reservation was not replaced exactly once."
        );
      },
    });
    verifyRepairedDocument({
      before: plan.originalDocument,
      after: writeResolution.document,
      context,
    });
    assert.equal(
      canonicalEjsonSha256(writeResolution.document),
      plan.expectedHash,
      "Repaired reservation hash mismatch."
    );
    const finalTransition = await transitionManifest({
      manifestCollection,
      identity,
      fromState: "applying",
      toState: "applied",
      token: applyToken,
      tokenField: "applyToken",
      set: {
        appliedAt: new Date(),
        verifiedHash: plan.expectedHash,
      },
    });
    return successfulApplyReport({
      context,
      plan,
      writeResolution,
      manifestAcknowledgementRecovered:
        manifestAcknowledgementRecovered || finalTransition.acknowledgementLost,
    });
  } catch (error) {
    let observed = null;
    let observationError = null;
    try {
      observed = await readReservationAfterWrite({ reservationCollection });
    } catch (caught) {
      observationError = caught;
    }
    const observedHash = observed ? canonicalEjsonSha256(observed) : "";
    if (observedHash === plan.expectedHash) {
      const manifest = await readManifest({
        manifestCollection,
        repairId: context.repairId,
      });
      if (
        matchesManifestIdentity(manifest, identity) &&
        manifest?.state === "applied" &&
        manifest?.applyToken === applyToken &&
        manifest?.verifiedHash === plan.expectedHash
      ) {
        return successfulApplyReport({
          context,
          plan,
          writeResolution: writeResolution || { acknowledgementLost: true },
          manifestAcknowledgementRecovered: true,
        });
      }
      if (
        matchesManifestIdentity(manifest, identity) &&
        manifest?.state === "applying" &&
        manifest?.applyToken === applyToken
      ) {
        await transitionManifest({
          manifestCollection,
          identity,
          fromState: "applying",
          toState: "applied",
          token: applyToken,
          tokenField: "applyToken",
          set: { appliedAt: new Date(), verifiedHash: plan.expectedHash },
        });
        return successfulApplyReport({
          context,
          plan,
          writeResolution: writeResolution || { acknowledgementLost: true },
          manifestAcknowledgementRecovered: true,
        });
      }
      throw new Error(
        `The exact repaired reservation is live, but manifest ${context.repairId} could not be finalized under this operator's fence. No compensation or write retry was attempted. Cause: ${error.message}`
      );
    }
    if (observedHash === plan.originalHash) {
      await markFailedNoChange({
        manifestCollection,
        identity,
        applyToken,
        cause: error,
      });
      throw new Error(
        `Apply failed with the exact original reservation verified unchanged. Manifest ${context.repairId} is permanently fenced and cannot be reused. Cause: ${error.message}`
      );
    }
    throw new Error(
      `Apply outcome is unresolved and no further write was attempted. Inspect manifest ${
        context.repairId
      }. Cause: ${error.message}. Observation: ${
        observationError?.message || observedHash || "unavailable"
      }`
    );
  }
};

const loadManifestAndBackup = async ({ db, manifestCollection, repairId }) => {
  const validatedRepairId = validateRepairId(repairId);
  const manifest = await readManifest({
    manifestCollection,
    repairId: validatedRepairId,
  });
  assert.ok(manifest, `Repair manifest ${validatedRepairId} was not found.`);
  assert.equal(manifest.operation, OPERATION, "Manifest operation mismatch.");
  assert.equal(
    manifest.targetMongoId,
    TARGET.mongoId,
    "Manifest target scope mismatch."
  );
  assert.equal(
    manifest.state,
    "applied",
    "Only an applied repair can be rolled back."
  );
  assert.equal(
    manifest.backupCollection,
    buildBackupCollectionName(validatedRepairId),
    "Manifest backup collection does not match the repair ID."
  );
  const context = {
    repairId: validatedRepairId,
    backupCollection: manifest.backupCollection,
    repairAt: new Date(manifest.repairAt),
    backupAt: new Date(manifest.backupAt),
  };
  const backupCollection = db.collection(manifest.backupCollection);
  const records = await listBackupRecords({ backupCollection });
  assert.equal(
    records.length,
    1,
    "Permanent backup must contain exactly one record."
  );
  const record = records[0];
  verifyBackupRecord({ record, context, manifest });
  const plan = buildRepairPlan({
    reservation: record.originalDocument,
    context,
  });
  assert.equal(
    plan.originalHash,
    manifest.originalHash,
    "Rebuilt original hash mismatch."
  );
  assert.equal(
    plan.expectedHash,
    manifest.expectedRepairedHash,
    "Rebuilt repaired hash mismatch."
  );
  assert.equal(
    plan.casFilterHash,
    manifest.casFilterHash,
    "Rebuilt CAS hash mismatch."
  );
  return { manifest, context, record, plan };
};

const claimRollback = async ({
  manifestCollection,
  loaded,
  tokenFactory = () => crypto.randomBytes(24).toString("hex"),
}) => {
  const rollbackToken = String(tokenFactory());
  assert.ok(rollbackToken, "Rollback ownership token is empty.");
  const identity = manifestIdentity({
    context: loaded.context,
    plan: loaded.plan,
    backupRecord: loaded.record,
  });
  const rollingBackAt = new Date();
  let acknowledgementError = null;
  try {
    const result = await manifestCollection.updateOne(
      { ...identity, state: "applied" },
      {
        $set: {
          state: "rolling_back",
          rollbackToken,
          rollingBackAt,
          updatedAt: rollingBackAt,
        },
      },
      writeOptions()
    );
    assert.equal(
      result.matchedCount,
      1,
      "Rollback manifest claim lost its fence."
    );
    assert.equal(
      result.modifiedCount,
      1,
      "Rollback manifest claim was not written."
    );
  } catch (error) {
    acknowledgementError = error;
  }
  const observed = await readManifest({
    manifestCollection,
    repairId: loaded.context.repairId,
  });
  if (
    matchesManifestIdentity(observed, identity) &&
    observed?.state === "rolling_back" &&
    observed?.rollbackToken === rollbackToken &&
    canonicalEqual(observed?.rollingBackAt, rollingBackAt)
  ) {
    return {
      identity,
      rollbackToken,
      acknowledgementLost: Boolean(acknowledgementError),
    };
  }
  throw new Error(
    `Rollback manifest ownership could not be claimed safely: ${
      acknowledgementError?.message || "readback mismatch"
    }`
  );
};

const successfulRollbackReport = ({
  loaded,
  resolution,
  manifestRecovered = false,
}) => ({
  ok: true,
  mode: "rollback",
  writesPerformed: true,
  repairId: loaded.context.repairId,
  reservationMongoId: TARGET.mongoId,
  restoredHash: loaded.plan.originalHash,
  writeAcknowledgementRecovered: resolution?.acknowledgementLost === true,
  manifestAcknowledgementRecovered: manifestRecovered,
});

const rollbackRepair = async ({
  db,
  reservationCollection,
  manifestCollection,
  args,
  tokenFactory,
}) => {
  const loaded = await loadManifestAndBackup({
    db,
    manifestCollection,
    repairId: args.repairId,
  });
  const current = await readTargetReservation({ reservationCollection });
  assert.ok(current, "Target reservation is missing; rollback is blocked.");
  assert.equal(
    canonicalEjsonSha256(current),
    loaded.plan.expectedHash,
    "Live reservation is not the exact repaired document; rollback is unsafe."
  );
  if (!args.apply) {
    return {
      ok: true,
      mode: "rollback-dry-run",
      writesPerformed: false,
      repairId: args.repairId,
      backupCollection: loaded.context.backupCollection,
      currentRepairedHash: loaded.plan.expectedHash,
      originalHash: loaded.plan.originalHash,
    };
  }

  const claim = await claimRollback({
    manifestCollection,
    loaded,
    tokenFactory,
  });
  let resolution = null;
  try {
    await assertManifestFence({
      manifestCollection,
      identity: claim.identity,
      state: "rolling_back",
      token: claim.rollbackToken,
      tokenField: "rollbackToken",
    });
    const fresh = await readTargetReservation({ reservationCollection });
    assert.equal(
      canonicalEjsonSha256(fresh),
      loaded.plan.expectedHash,
      "Live reservation changed after rollback planning; rollback is blocked."
    );
    resolution = await executeWriteWithHashReadback({
      reservationCollection,
      write: () =>
        reservationCollection.replaceOne(
          buildStrictExactCasFilter(fresh),
          cloneBson(loaded.record.originalDocument),
          writeOptions()
        ),
      beforeHash: loaded.plan.expectedHash,
      afterHash: loaded.plan.originalHash,
      validateAcknowledgement: (result) => {
        assert.equal(
          result.matchedCount,
          1,
          "Rollback full-document CAS did not match."
        );
        assert.equal(
          result.modifiedCount,
          1,
          "Rollback did not restore exactly once."
        );
      },
    });
    validateCurrentReservation(resolution.document);
    assert.equal(
      canonicalEjsonSha256(resolution.document),
      loaded.plan.originalHash,
      "Rollback original hash mismatch."
    );
    const transition = await transitionManifest({
      manifestCollection,
      identity: claim.identity,
      fromState: "rolling_back",
      toState: "rolled_back",
      token: claim.rollbackToken,
      tokenField: "rollbackToken",
      set: {
        rolledBackAt: new Date(),
        verifiedOriginalHash: loaded.plan.originalHash,
      },
    });
    return successfulRollbackReport({
      loaded,
      resolution,
      manifestRecovered:
        claim.acknowledgementLost || transition.acknowledgementLost,
    });
  } catch (error) {
    let observed = null;
    let observationError = null;
    try {
      observed = await readReservationAfterWrite({ reservationCollection });
    } catch (caught) {
      observationError = caught;
    }
    const observedHash = observed ? canonicalEjsonSha256(observed) : "";
    const manifest = await readManifest({
      manifestCollection,
      repairId: loaded.context.repairId,
    });
    if (observedHash === loaded.plan.originalHash) {
      if (
        matchesManifestIdentity(manifest, claim.identity) &&
        manifest?.state === "rolled_back" &&
        manifest?.rollbackToken === claim.rollbackToken &&
        manifest?.verifiedOriginalHash === loaded.plan.originalHash
      ) {
        return successfulRollbackReport({
          loaded,
          resolution: resolution || { acknowledgementLost: true },
          manifestRecovered: true,
        });
      }
      if (
        matchesManifestIdentity(manifest, claim.identity) &&
        manifest?.state === "rolling_back" &&
        manifest?.rollbackToken === claim.rollbackToken
      ) {
        await transitionManifest({
          manifestCollection,
          identity: claim.identity,
          fromState: "rolling_back",
          toState: "rolled_back",
          token: claim.rollbackToken,
          tokenField: "rollbackToken",
          set: {
            rolledBackAt: new Date(),
            verifiedOriginalHash: loaded.plan.originalHash,
          },
        });
        return successfulRollbackReport({
          loaded,
          resolution: resolution || { acknowledgementLost: true },
          manifestRecovered: true,
        });
      }
      throw new Error(
        `Original document was restored, but rollback manifest ${loaded.context.repairId} could not be finalized under this fence. No additional reservation write was attempted.`
      );
    }
    if (
      observedHash === loaded.plan.expectedHash &&
      matchesManifestIdentity(manifest, claim.identity) &&
      manifest?.state === "rolling_back" &&
      manifest?.rollbackToken === claim.rollbackToken
    ) {
      await transitionManifest({
        manifestCollection,
        identity: claim.identity,
        fromState: "rolling_back",
        toState: "applied",
        token: claim.rollbackToken,
        tokenField: "rollbackToken",
        set: {
          rollbackFailedNoChangeAt: new Date(),
          rollbackError: String(error.message).slice(0, 1000),
        },
      });
      throw new Error(
        `Rollback failed with the exact repaired reservation verified unchanged; manifest returned to applied. Cause: ${error.message}`
      );
    }
    throw new Error(
      `Rollback outcome is unresolved and no further write was attempted. Inspect manifest ${
        loaded.context.repairId
      }. Cause: ${error.message}. Observation: ${
        observationError?.message || observedHash || "unavailable"
      }`
    );
  }
};

const main = async () => {
  const args = parseArguments(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const database =
    process.env.DATABASE || process.env.MONGO_URI || process.env.MONGODB_URI;
  assert.ok(database, "Missing DATABASE/MONGO connection string.");
  await mongoose.connect(database, {
    autoIndex: false,
    readPreference: "primary",
    writeConcern: { w: "majority" },
  });
  const db = mongoose.connection.db;
  const reservationCollection = Reservations.collection;
  const manifestCollection = db.collection(MANIFEST_COLLECTION);
  if (args.rollback) {
    console.log(
      JSON.stringify(
        await rollbackRepair({
          db,
          reservationCollection,
          manifestCollection,
          args,
        }),
        null,
        2
      )
    );
    return;
  }

  const now = args.repairAt ? new Date(args.repairAt) : new Date();
  const previewRepairId = args.repairId || "dry-run-preview";
  const context = {
    repairId: previewRepairId,
    backupCollection: buildBackupCollectionName(previewRepairId),
    repairAt: now,
    backupAt: now,
  };
  const reservation = await loadCurrentReservation({ reservationCollection });
  const plan = buildRepairPlan({ reservation, context });
  if (!args.apply) {
    console.log(
      JSON.stringify(
        dryRunReport({
          plan,
          context,
          explicitRepairId: Boolean(args.repairId),
        }),
        null,
        2
      )
    );
    return;
  }
  console.log(
    JSON.stringify(
      await applyRepair({
        db,
        reservationCollection,
        manifestCollection,
        plan,
        context,
      }),
      null,
      2
    )
  );
};

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(
        JSON.stringify({ ok: false, error: error.message }, null, 2)
      );
      process.exitCode = 1;
    })
    .finally(async () => {
      if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    });
}

module.exports = {
  BACKUP_RECORD_ID,
  PRIMARY_MAJORITY_READ,
  MAJORITY_WRITE,
  applyRepair,
  assertManifestFence,
  buildBackupRecord,
  claimNewRepair,
  createAndVerifyBackup,
  dryRunReport,
  executeWriteWithHashReadback,
  loadCurrentReservation,
  loadManifestAndBackup,
  parseArguments,
  readOptions,
  readReservationAfterWrite,
  rollbackRepair,
  transitionManifest,
  validateRepairAt,
  verifyBackupRecord,
  writeOptions,
};
