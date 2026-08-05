/** @format */

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const mongoose = require("mongoose");

const {
  OPERATION,
  TARGET,
  buildBackupCollectionName,
  buildExpectedDocument,
  buildRepairPlan,
  buildStrictExactCasFilter,
  validateCurrentReservation,
  validateRepairId,
  verifyRepairedDocument,
} = require("./otaPricingSaveIncidentRepair20260805");
const {
  BACKUP_RECORD_ID,
  applyRepair,
  assertManifestFence,
  buildBackupRecord,
  dryRunReport,
  executeWriteWithHashReadback,
  parseArguments,
  rollbackRepair,
  validateRepairAt,
  verifyBackupRecord,
} = require("../scripts/repairOtaPricingSaveIncident20260805");
const {
  buildExactCasFilter,
  canonicalEjsonSha256,
  canonicalEqual,
  cloneBson,
} = require("./tripHotelRunnerRepair20260805");

const objectId = (value) => new mongoose.Types.ObjectId(String(value));

const pricingDays = () =>
  Array.from({ length: TARGET.nights }, (_, index) => {
    const date = new Date(`${TARGET.checkin}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + index);
    return {
      date: date.toISOString().slice(0, 10),
      price: 69.85,
      clientPrice: 69.85,
      mainPrice: 69.85,
      totalPriceWithCommission: 69.85,
      rootPrice: 75,
      totalPriceWithoutCommission: 75,
      netAfterExpenses: 43.22,
      netAfterOtaExpenses: 43.22,
      otaExpenseAmount: 26.63,
      platformMargin: -31.78,
      platformMarginRate: -73.53,
    };
  });

const reservationFixture = () => {
  const room = {
    room_type: "doubleRooms",
    displayName: "Double Room – Comfort & Relaxation",
    sourceRoomName: "Comfort Double - Non-Smoking (Comfort Double Room-)",
    hotelRoomConfigId: objectId("6a40df5f1a6d1850eb25c183"),
    count: 1,
    pricingByDay: pricingDays(),
  };
  const emptyPending = {
    status: "",
    rejectionReason: "",
    confirmationReason: "",
    confirmedAt: null,
    rejectedAt: null,
    lastUpdatedAt: null,
    lastUpdatedBy: null,
  };
  const emptyDecision = {
    status: "",
    reason: "",
    decidedAt: null,
    decidedBy: null,
  };
  return {
    _id: objectId(TARGET.mongoId),
    reservation_id: TARGET.otaConfirmation,
    confirmation_number: TARGET.pmsConfirmation,
    booking_source: "agoda",
    hotelId: objectId(TARGET.hotelId),
    belongsTo: objectId("68b74714fb50e159d48c714d"),
    checkin_date: new Date(`${TARGET.checkin}T00:00:00.000Z`),
    checkout_date: new Date(`${TARGET.checkout}T00:00:00.000Z`),
    days_of_residence: TARGET.nights,
    total_rooms: 1,
    total_amount: TARGET.clientTotal,
    sub_total: TARGET.rootTotal,
    commission: 0,
    state: "confirmed",
    reservation_status: "confirmed",
    pickedRoomsType: [cloneBson(room)],
    pickedRoomsPricing: [cloneBson(room)],
    customer_details: {
      name: "preserved guest",
      email: "preserved@example.test",
      confirmation_number2: TARGET.otaConfirmation,
    },
    supplierData: {
      otaProvider: "agoda",
      otaConfirmationNumber: TARGET.otaConfirmation,
      platformConfirmationNumber: TARGET.otaConfirmation,
      pmsConfirmationNumber: TARGET.pmsConfirmation,
    },
    payment: "virtual card",
    payment_details: { captured: false, untouched: true },
    nullableMaintenanceMarker: null,
    commissionData: {
      assigned: false,
      amount: 0,
      status: "",
      resetAt: new Date(TARGET.pricingAuditTimes[1]),
      resetReason: "reservation_pricing_changed",
    },
    adminPricing: {
      mode: "ota_review",
      clientTotal: TARGET.clientTotal,
      rootTotal: TARGET.rootTotal,
      netAfterExpensesTotal: TARGET.netTotal,
      otaExpenseTotal: TARGET.otaExpenseTotal,
      platformMarginTotal: TARGET.platformMarginTotal,
      commissionAmount: 0,
      sourceClientTotalSar: TARGET.clientTotal,
      pricingReviewRequired: false,
    },
    financial_cycle: {
      collectionModel: "pms_collected",
      status: "open",
      commissionType: "amount",
      commissionValue: 0,
      commissionAmount: 0,
      commissionAssigned: false,
      pmsCollectedAmount: TARGET.clientTotal,
      hotelCollectedAmount: 0,
      hotelPayoutDue: TARGET.rootTotal,
      commissionDueToPms: 0,
      lastUpdatedAt: new Date(TARGET.pricingAuditTimes[1]),
      lastUpdatedBy: objectId("6553f1c6d06c5cea2f98a838"),
    },
    pendingConfirmation: {
      status: "confirmed",
      confirmationReason: "Admin status update: confirmed",
      confirmedAt: new Date("2026-08-05T16:05:57.729Z"),
      lastUpdatedAt: new Date("2026-08-05T16:05:57.729Z"),
    },
    agentDecisionSnapshot: {
      status: "confirmed",
      reason: "Admin status update: confirmed",
      decidedAt: new Date("2026-08-05T16:05:57.729Z"),
      lastUpdatedAt: new Date("2026-08-05T16:05:57.729Z"),
    },
    otaPlatformReview: {
      status: "pending",
      source: "ota_email_create",
      provider: "agoda",
      confirmationNumber: TARGET.otaConfirmation,
      createdAt: new Date("2026-08-05T15:04:39.459Z"),
      releasedAt: null,
      releasedBy: null,
      priceAtRelease: 0,
      lastPricingUpdatedAt: new Date(TARGET.pricingAuditTimes[1]),
    },
    reservationAuditLog: [
      {
        at: new Date("2026-08-05T15:04:39.576Z"),
        action: "created-from-email",
        provider: "agoda",
      },
      {
        at: new Date(TARGET.statusAuditAt),
        action: "reservation_update",
        field: "reservation_status",
        from: "ota platform review",
        to: "confirmed",
      },
      {
        at: new Date(TARGET.statusAuditAt),
        action: "reservation_update",
        field: "pendingConfirmation",
        from: cloneBson(emptyPending),
        to: { status: "confirmed" },
      },
      {
        at: new Date(TARGET.statusAuditAt),
        action: "reservation_update",
        field: "agentDecisionSnapshot",
        from: cloneBson(emptyDecision),
        to: { status: "confirmed" },
      },
      {
        at: new Date(TARGET.pricingAuditTimes[0]),
        source: "ota-review",
        action: "pricing-updated-before-release",
        from: { commission: 165 },
        to: { commission: 0 },
      },
      {
        at: new Date(TARGET.pricingAuditTimes[1]),
        source: "ota-review",
        action: "pricing-updated-before-release",
        from: { commission: 0 },
        to: { commission: 0 },
      },
    ],
    adminLastUpdatedAt: new Date(TARGET.pricingAuditTimes[1]),
    adminLastUpdatedBy: { role: 1000 },
    createdAt: new Date("2026-08-05T15:04:39.628Z"),
    updatedAt: new Date("2026-08-05T17:04:24.760Z"),
    __v: 2,
  };
};

const contextFixture = () => {
  const repairId = "ota-pricing-20260805-unit";
  return {
    repairId,
    backupCollection: buildBackupCollectionName(repairId),
    repairAt: new Date("2026-08-05T18:00:00.000Z"),
    backupAt: new Date("2026-08-05T18:00:00.000Z"),
  };
};

const sameValue = (left, right) => canonicalEqual(left, right);

const matchesMongoStyleExactFilter = (document, filter) => {
  const clauses = Array.isArray(filter?.$and) ? filter.$and : [];
  const baseline = clauses[0] || {};
  for (const [field, expected] of Object.entries(baseline)) {
    const present = Object.prototype.hasOwnProperty.call(document, field);
    if (expected === null) {
      if (present && document[field] !== null) return false;
    } else if (!present || !canonicalEqual(document[field], expected)) {
      return false;
    }
  }
  const expectedFieldCount = Object.keys(baseline).length;
  if (Object.keys(document).length !== expectedFieldCount) return false;
  for (const clause of clauses.slice(2)) {
    for (const [field, condition] of Object.entries(clause)) {
      if (
        condition?.$exists === true &&
        !Object.prototype.hasOwnProperty.call(document, field)
      ) {
        return false;
      }
    }
  }
  return true;
};

const matchesSimpleFilter = (document, filter = {}) =>
  Object.entries(filter).every(([key, value]) =>
    sameValue(document?.[key], value)
  );

const memoryCollection = (
  initialDocuments = [],
  { afterInsert, afterUpdate } = {}
) => {
  const documents = new Map(
    initialDocuments.map((document) => [
      String(document._id),
      cloneBson(document),
    ])
  );
  const operationOptions = [];
  return {
    documents,
    operationOptions,
    async findOne(filter = {}, options = {}) {
      operationOptions.push({ operation: "findOne", options });
      const found = [...documents.values()].find((document) =>
        matchesSimpleFilter(document, filter)
      );
      return found ? cloneBson(found) : null;
    },
    find(_filter = {}, options = {}) {
      operationOptions.push({ operation: "find", options });
      return {
        sort() {
          return this;
        },
        async toArray() {
          return [...documents.values()].map(cloneBson);
        },
      };
    },
    async insertOne(document, options = {}) {
      operationOptions.push({ operation: "insertOne", options });
      const key = String(document._id);
      if (documents.has(key)) {
        const error = new Error("duplicate key");
        error.code = 11000;
        throw error;
      }
      documents.set(key, cloneBson(document));
      if (afterInsert) await afterInsert({ document: documents.get(key) });
      return { insertedId: document._id };
    },
    async updateOne(filter, update, options = {}) {
      operationOptions.push({ operation: "updateOne", options });
      const entry = [...documents.entries()].find(([, document]) =>
        matchesSimpleFilter(document, filter)
      );
      if (!entry) return { matchedCount: 0, modifiedCount: 0 };
      const [key, document] = entry;
      Object.assign(document, cloneBson(update.$set || {}));
      documents.set(key, document);
      if (afterUpdate) await afterUpdate({ filter, update, document });
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };
};

const maintenanceHarness = ({
  reservationLostAcknowledgement = false,
  rollbackLostAcknowledgement = false,
  manifestInsertLostAcknowledgement = false,
  manifestLostAcknowledgementState = "",
  driftAfterBackupCreation = false,
} = {}) => {
  const original = reservationFixture();
  const context = contextFixture();
  const plan = buildRepairPlan({ reservation: original, context });
  let storedReservation = cloneBson(original);
  let reservationLostPending = reservationLostAcknowledgement;
  let rollbackLostPending = rollbackLostAcknowledgement;
  let manifestInsertLostPending = manifestInsertLostAcknowledgement;
  let manifestLostPending = Boolean(manifestLostAcknowledgementState);
  let driftPending = driftAfterBackupCreation;
  let replacementCount = 0;
  const reservationOptions = [];
  const reservationCollection = {
    async findOne(_filter, options = {}) {
      reservationOptions.push({ operation: "findOne", options });
      return cloneBson(storedReservation);
    },
    async replaceOne(filter, replacement, options = {}) {
      reservationOptions.push({ operation: "replaceOne", options });
      assert.ok(
        Array.isArray(filter?.$and),
        "Reservation write did not use full CAS."
      );
      const filterHash = canonicalEjsonSha256(filter.$and[0]);
      if (filterHash !== canonicalEjsonSha256(storedReservation)) {
        return { matchedCount: 0, modifiedCount: 0 };
      }
      storedReservation = cloneBson(replacement);
      replacementCount += 1;
      const isRollback =
        canonicalEjsonSha256(replacement) === plan.originalHash;
      if (!isRollback && reservationLostPending) {
        reservationLostPending = false;
        throw new Error("simulated apply acknowledgement loss");
      }
      if (isRollback && rollbackLostPending) {
        rollbackLostPending = false;
        throw new Error("simulated rollback acknowledgement loss");
      }
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };
  const manifestCollection = memoryCollection([], {
    afterInsert: () => {
      if (manifestInsertLostPending) {
        manifestInsertLostPending = false;
        throw new Error("simulated manifest insert acknowledgement loss");
      }
    },
    afterUpdate: ({ update }) => {
      if (
        manifestLostPending &&
        update.$set?.state === manifestLostAcknowledgementState
      ) {
        manifestLostPending = false;
        throw new Error(
          `simulated ${manifestLostAcknowledgementState} manifest acknowledgement loss`
        );
      }
    },
  });
  const collectionsByName = new Map([
    ["ota_pricing_save_incident_manifests_20260805", manifestCollection],
  ]);
  const createOptions = [];
  const db = {
    listCollections({ name }) {
      return {
        async toArray() {
          return collectionsByName.has(name) ? [{ name }] : [];
        },
      };
    },
    async createCollection(name, options = {}) {
      assert.equal(collectionsByName.has(name), false);
      createOptions.push(options);
      collectionsByName.set(name, memoryCollection());
      if (name === context.backupCollection && driftPending) {
        driftPending = false;
        storedReservation.customer_details.name = "concurrent legitimate edit";
      }
    },
    collection(name) {
      const collection = collectionsByName.get(name);
      assert.ok(collection, `Missing fake collection ${name}.`);
      return collection;
    },
  };
  return {
    context,
    createOptions,
    db,
    manifestCollection,
    plan,
    reservationCollection,
    reservationOptions,
    replacementCount: () => replacementCount,
    setStoredReservation: (document) => {
      storedReservation = cloneBson(document);
    },
    storedReservation: () => cloneBson(storedReservation),
  };
};

test("pricing incident validation is exact and fails closed on drift", () => {
  const valid = reservationFixture();
  assert.doesNotThrow(() => validateCurrentReservation(valid));
  for (const mutate of [
    (document) => (document._id = objectId("6a735107b880d28d664f6038")),
    (document) => (document.confirmation_number = "wrong"),
    (document) => (document.supplierData.otaConfirmationNumber = "wrong"),
    (document) => (document.otaPlatformReview.confirmationNumber = "wrong"),
    (document) => (document.booking_source = "wrong"),
    (document) => (document.supplierData.otaProvider = "wrong"),
    (document) => (document.otaPlatformReview.provider = "wrong"),
    (document) => (document.hotelId = objectId("6a40b6a1a6efe70450536037")),
    (document) => (document.checkin_date = new Date("2026-08-17T00:00:00Z")),
    (document) => (document.total_amount = 1),
    (document) => (document.total_amount = "not-money"),
    (document) => (document.commission = 1),
    (document) => (document.otaPlatformReview.releasedAt = new Date()),
    (document) => (document.otaPlatformReview.releasedAt = ""),
    (document) =>
      (document.otaPlatformReview.releasedBy = objectId(
        "6553f1c6d06c5cea2f98a838"
      )),
    (document) => (document.otaPlatformReview.releasedBy = false),
    (document) => (document.total_rooms = 2),
    (document) => (document.__v = 3),
    (document) => (document.updatedAt = new Date("2026-08-05T17:04:25.760Z")),
    (document) => {
      document.pickedRoomsType[0].room_type = "wrong";
      document.pickedRoomsPricing[0].room_type = "wrong";
    },
    (document) => {
      document.pickedRoomsType[0].hotelRoomConfigId = objectId(
        "6a40df5f1a6d1850eb25c184"
      );
      document.pickedRoomsPricing[0].hotelRoomConfigId = objectId(
        "6a40df5f1a6d1850eb25c184"
      );
    },
    (document) => {
      document.pickedRoomsType[0].count = "invalid";
      document.pickedRoomsPricing[0].count = "invalid";
    },
    (document) => {
      document.pickedRoomsType[0].count = "";
      document.pickedRoomsPricing[0].count = "";
    },
    (document) => {
      document.pickedRoomsType[0].pricingByDay[0].rootPrice = "invalid";
      document.pickedRoomsPricing[0].pricingByDay[0].rootPrice = "invalid";
    },
    (document) =>
      (document.pickedRoomsPricing[0].pricingByDay[0].rootPrice = 1),
    (document) => {
      const audit = document.reservationAuditLog.find(
        (entry) => entry.field === "pendingConfirmation"
      );
      audit.from = null;
    },
    (document) => {
      const audit = document.reservationAuditLog.find(
        (entry) => entry.field === "agentDecisionSnapshot"
      );
      audit.from.decidedAt = new Date();
    },
    (document) => document.reservationAuditLog.pop(),
  ]) {
    const changed = reservationFixture();
    mutate(changed);
    assert.throws(() => validateCurrentReservation(changed));
  }
});

test("repair changes only the proven lifecycle and commission fields", () => {
  const before = reservationFixture();
  const context = contextFixture();
  const after = buildExpectedDocument({ reservation: before, context });
  assert.equal(after.reservation_status, "OTA Platform Review");
  assert.equal(after.state, "OTA Platform Review");
  assert.equal(after.commission, TARGET.intendedCommission);
  assert.equal(after.adminPricing.commissionAmount, TARGET.intendedCommission);
  assert.equal(
    after.financial_cycle.commissionAmount,
    TARGET.intendedCommission
  );
  assert.equal(
    after.financial_cycle.commissionValue,
    TARGET.intendedCommission
  );
  assert.equal(after.pendingConfirmation.status, "");
  assert.equal(after.agentDecisionSnapshot.status, "");
  assert.equal(after.otaPlatformReview.status, "pending");
  assert.equal(after.otaPlatformReview.releasedAt, null);
  assert.ok(canonicalEqual(after.otaPlatformReview, before.otaPlatformReview));
  assert.equal("pricingIncidentRepairedAt" in after.otaPlatformReview, false);
  assert.equal("pricingIncidentRepairId" in after.otaPlatformReview, false);
  assert.ok(
    canonicalEqual(after.adminLastUpdatedAt, before.adminLastUpdatedAt)
  );
  assert.ok(
    canonicalEqual(after.adminLastUpdatedBy, before.adminLastUpdatedBy)
  );
  assert.ok(
    canonicalEqual(
      after.financial_cycle.lastUpdatedAt,
      before.financial_cycle.lastUpdatedAt
    )
  );
  assert.ok(
    canonicalEqual(
      after.financial_cycle.lastUpdatedBy,
      before.financial_cycle.lastUpdatedBy
    )
  );
  assert.equal(after.__v, before.__v + 1);
  for (const field of [
    "customer_details",
    "supplierData",
    "payment",
    "payment_details",
    "commissionData",
    "pickedRoomsType",
    "pickedRoomsPricing",
    "hotelId",
    "belongsTo",
    "checkin_date",
    "checkout_date",
  ]) {
    assert.ok(
      canonicalEqual(after[field], before[field]),
      `${field} was not preserved.`
    );
  }
  assert.equal(after.adminPricing.rootTotal, before.adminPricing.rootTotal);
  assert.equal(
    after.financial_cycle.pmsCollectedAmount,
    before.financial_cycle.pmsCollectedAmount
  );
  assert.doesNotThrow(() => verifyRepairedDocument({ before, after, context }));
});

test("repair plan uses full-document CAS and verified canonical hashes", () => {
  const before = reservationFixture();
  const context = contextFixture();
  const plan = buildRepairPlan({ reservation: before, context });
  assert.ok(Array.isArray(plan.casFilter.$and));
  assert.ok(canonicalEqual(plan.casFilter.$and[0], before));
  assert.equal(
    plan.casFilter.$and.length,
    Object.keys(before).length + 2,
    "CAS must include a presence fence for every original top-level key."
  );
  assert.equal(plan.originalHash, canonicalEjsonSha256(before));
  assert.equal(plan.expectedHash, canonicalEjsonSha256(plan.expectedDocument));
  assert.equal(plan.casFilterHash, canonicalEjsonSha256(plan.casFilter));
  assert.notEqual(plan.originalHash, plan.expectedHash);
});

test("strict CAS rejects a same-count swap of a null field for a concurrent field", () => {
  const before = reservationFixture();
  const concurrent = cloneBson(before);
  delete concurrent.nullableMaintenanceMarker;
  concurrent.concurrentOperatorField = "must never be overwritten";
  assert.equal(Object.keys(concurrent).length, Object.keys(before).length);
  assert.equal(
    matchesMongoStyleExactFilter(concurrent, buildExactCasFilter(before)),
    true,
    "Regression setup must demonstrate Mongo null/missing plus field-count ambiguity."
  );
  const strictFilter = buildStrictExactCasFilter(before);
  assert.equal(matchesMongoStyleExactFilter(concurrent, strictFilter), false);
  assert.ok(
    strictFilter.$and.some((clause) =>
      canonicalEqual(clause, {
        nullableMaintenanceMarker: { $exists: true },
      })
    )
  );
});

test("repair IDs and CLI write interlocks are explicit", () => {
  assert.deepEqual(parseArguments([]), {
    apply: false,
    rollback: false,
    repairId: "",
    repairAt: "",
    help: false,
  });
  assert.throws(() => parseArguments(["--apply"]));
  assert.throws(() =>
    parseArguments(["--apply", "--repair-id", "ota-pricing-valid-1"])
  );
  assert.throws(() => parseArguments(["--rollback"]));
  assert.throws(() => parseArguments(["--repair-id", "short"]));
  assert.throws(() =>
    parseArguments(["--repair-at", "2026-08-05T18:00:00.000Z"])
  );
  assert.throws(() =>
    parseArguments([
      "--repair-id",
      "ota-pricing-valid-1",
      "--repair-at",
      "2026-08-05T18:00:00Z",
    ])
  );
  assert.throws(() => validateRepairAt("2026-08-05T17:04:24.760Z"));
  assert.throws(() => parseArguments(["--unknown"]));
  assert.equal(validateRepairId("ota-pricing-valid-1"), "ota-pricing-valid-1");
  assert.equal(
    validateRepairAt("2026-08-05T18:00:00.000Z"),
    "2026-08-05T18:00:00.000Z"
  );
  assert.deepEqual(
    parseArguments([
      "--apply",
      "--repair-id",
      "ota-pricing-valid-1",
      "--repair-at",
      "2026-08-05T18:00:00.000Z",
    ]),
    {
      apply: true,
      rollback: false,
      repairId: "ota-pricing-valid-1",
      repairAt: "2026-08-05T18:00:00.000Z",
      help: false,
    }
  );
  assert.deepEqual(
    parseArguments(["--rollback", "--repair-id", "ota-pricing-valid-1"]),
    {
      apply: false,
      rollback: true,
      repairId: "ota-pricing-valid-1",
      repairAt: "",
      help: false,
    }
  );
  assert.throws(() =>
    parseArguments([
      "--rollback",
      "--repair-id",
      "ota-pricing-valid-1",
      "--repair-at",
      "2026-08-05T18:00:00.000Z",
    ])
  );
});

test("dry-run emits the exact deterministic apply command and backup hash", () => {
  const context = contextFixture();
  const original = reservationFixture();
  const first = buildRepairPlan({ reservation: original, context });
  const sameContext = {
    ...context,
    repairAt: new Date(context.repairAt),
    backupAt: new Date(context.backupAt),
  };
  const second = buildRepairPlan({
    reservation: original,
    context: sameContext,
  });
  assert.equal(first.expectedHash, second.expectedHash);
  assert.equal(
    buildBackupRecord({ plan: first, context }).recordHash,
    buildBackupRecord({ plan: second, context: sameContext }).recordHash
  );
  const report = dryRunReport({
    plan: first,
    context,
    explicitRepairId: true,
  });
  assert.equal(report.reusableForApply, true);
  assert.equal(report.repairAt, "2026-08-05T18:00:00.000Z");
  assert.equal(
    report.exactApplyCommand,
    "node scripts/repairOtaPricingSaveIncident20260805.js --apply --repair-id ota-pricing-20260805-unit --repair-at 2026-08-05T18:00:00.000Z"
  );
  assert.equal(
    report.evidence.backupRecordHash,
    buildBackupRecord({ plan: first, context }).recordHash
  );
});

test("permanent backup contains the complete raw document and independent hashes", () => {
  const context = contextFixture();
  const plan = buildRepairPlan({ reservation: reservationFixture(), context });
  const record = buildBackupRecord({ plan, context });
  assert.equal(record._id, BACKUP_RECORD_ID);
  assert.ok(canonicalEqual(record.originalDocument, plan.originalDocument));
  assert.doesNotThrow(() => verifyBackupRecord({ record, context }));

  const corrupted = cloneBson(record);
  corrupted.originalDocument.customer_details.name = "tampered";
  assert.throws(() => verifyBackupRecord({ record: corrupted, context }));
  assert.throws(() =>
    buildBackupRecord({
      plan,
      context: {
        ...context,
        backupAt: new Date("2026-08-05T18:00:01.000Z"),
      },
    })
  );
});

test("lost reservation acknowledgement is resolved by exact hash readback", async () => {
  const context = contextFixture();
  const plan = buildRepairPlan({ reservation: reservationFixture(), context });
  let stored = cloneBson(plan.originalDocument);
  const collection = {
    async findOne() {
      return cloneBson(stored);
    },
  };
  const resolved = await executeWriteWithHashReadback({
    reservationCollection: collection,
    write: async () => {
      stored = cloneBson(plan.expectedDocument);
      throw new Error("simulated lost acknowledgement");
    },
    beforeHash: plan.originalHash,
    afterHash: plan.expectedHash,
  });
  assert.equal(resolved.state, "after");
  assert.equal(resolved.acknowledgementLost, true);

  stored = cloneBson(plan.originalDocument);
  await assert.rejects(
    executeWriteWithHashReadback({
      reservationCollection: collection,
      write: async () => {
        throw new Error("simulated write rejection before commit");
      },
      beforeHash: plan.originalHash,
      afterHash: plan.expectedHash,
    }),
    (error) => error.writeResolution === "before"
  );

  stored = cloneBson(plan.originalDocument);
  stored.unexpected = true;
  await assert.rejects(
    executeWriteWithHashReadback({
      reservationCollection: collection,
      write: async () => {
        throw new Error("ambiguous write");
      },
      beforeHash: plan.originalHash,
      afterHash: plan.expectedHash,
    }),
    (error) => error.writeResolution === "unexpected"
  );
});

test("apply is fenced, backed up, majority-scoped, and survives lost acknowledgements", async () => {
  for (const fault of [
    { reservationLostAcknowledgement: true },
    { manifestInsertLostAcknowledgement: true },
    { manifestLostAcknowledgementState: "backed_up" },
    { manifestLostAcknowledgementState: "applying" },
    { manifestLostAcknowledgementState: "applied" },
  ]) {
    const harness = maintenanceHarness(fault);
    const result = await applyRepair({
      db: harness.db,
      reservationCollection: harness.reservationCollection,
      manifestCollection: harness.manifestCollection,
      plan: harness.plan,
      context: harness.context,
      tokenFactory: () => "apply-token-unit-test",
    });
    assert.equal(result.ok, true);
    assert.equal(result.writesPerformed, true);
    if (
      fault.manifestInsertLostAcknowledgement ||
      fault.manifestLostAcknowledgementState
    ) {
      assert.equal(result.manifestAcknowledgementRecovered, true);
    }
    assert.equal(
      canonicalEjsonSha256(harness.storedReservation()),
      harness.plan.expectedHash
    );
    assert.equal(
      harness.replacementCount(),
      1,
      "Reservation write was retried."
    );
    const backup = harness.db.collection(harness.context.backupCollection);
    assert.equal(backup.documents.size, 1);
    assert.equal(harness.createOptions[0].writeConcern.w, "majority");
    assert.ok(
      harness.manifestCollection.operationOptions
        .filter((entry) => entry.operation === "findOne")
        .every(
          (entry) =>
            entry.options.readPreference === "primary" &&
            entry.options.readConcern.level === "majority"
        )
    );
    assert.ok(
      harness.manifestCollection.operationOptions
        .filter((entry) => ["insertOne", "updateOne"].includes(entry.operation))
        .every((entry) => entry.options.writeConcern.w === "majority")
    );
    assert.ok(
      backup.operationOptions
        .filter((entry) => entry.operation === "find")
        .every(
          (entry) =>
            entry.options.readPreference === "primary" &&
            entry.options.readConcern.level === "majority"
        )
    );
    assert.ok(
      backup.operationOptions
        .filter((entry) => entry.operation === "insertOne")
        .every((entry) => entry.options.writeConcern.w === "majority")
    );
    const manifest = await harness.manifestCollection.findOne({
      _id: harness.context.repairId,
    });
    assert.equal(manifest.operation, OPERATION);
    assert.equal(manifest.state, "applied");
    assert.equal(manifest.verifiedHash, harness.plan.expectedHash);
    const reservationWrite = harness.reservationOptions.find(
      (entry) => entry.operation === "replaceOne"
    );
    assert.equal(reservationWrite.options.writeConcern.w, "majority");
    assert.ok(
      harness.reservationOptions
        .filter((entry) => entry.operation === "findOne")
        .every(
          (entry) =>
            entry.options.readPreference === "primary" &&
            entry.options.readConcern.level === "majority"
        )
    );
  }
});

test("manifest fence mismatch blocks the reservation write", async () => {
  const harness = maintenanceHarness();
  const record = buildBackupRecord({
    plan: harness.plan,
    context: harness.context,
  });
  const identity = {
    _id: harness.context.repairId,
    operation: OPERATION,
    targetMongoId: TARGET.mongoId,
    backupCollection: harness.context.backupCollection,
    repairAt: new Date(harness.context.repairAt),
    backupAt: new Date(harness.context.backupAt),
    originalHash: harness.plan.originalHash,
    expectedRepairedHash: harness.plan.expectedHash,
    casFilterHash: harness.plan.casFilterHash,
    backupRecordHash: record.recordHash,
  };
  await harness.manifestCollection.insertOne({
    ...identity,
    state: "applying",
    applyToken: "another-operator",
  });
  await assert.rejects(
    assertManifestFence({
      manifestCollection: harness.manifestCollection,
      identity,
      state: "applying",
      token: "our-token",
      tokenField: "applyToken",
    }),
    /ownership was lost/
  );
  assert.equal(harness.replacementCount(), 0);
});

test("apply refuses target drift after the permanent backup and never retries CAS", async () => {
  const harness = maintenanceHarness({ driftAfterBackupCreation: true });
  await assert.rejects(
    applyRepair({
      db: harness.db,
      reservationCollection: harness.reservationCollection,
      manifestCollection: harness.manifestCollection,
      plan: harness.plan,
      context: harness.context,
      tokenFactory: () => "apply-token-unit-test",
    }),
    /Apply outcome is unresolved.*Target reservation changed/
  );
  assert.equal(harness.replacementCount(), 0);
  assert.equal(
    harness.storedReservation().customer_details.name,
    "concurrent legitimate edit"
  );
  const manifest = await harness.manifestCollection.findOne({
    _id: harness.context.repairId,
  });
  assert.equal(manifest.state, "backed_up");
});

test("rollback is conditional on the exact repaired hash and resolves lost acknowledgement", async () => {
  const harness = maintenanceHarness({
    rollbackLostAcknowledgement: true,
    manifestLostAcknowledgementState: "rolled_back",
  });
  await applyRepair({
    db: harness.db,
    reservationCollection: harness.reservationCollection,
    manifestCollection: harness.manifestCollection,
    plan: harness.plan,
    context: harness.context,
    tokenFactory: () => "apply-token-unit-test",
  });
  const dryRun = await rollbackRepair({
    db: harness.db,
    reservationCollection: harness.reservationCollection,
    manifestCollection: harness.manifestCollection,
    args: {
      apply: false,
      rollback: true,
      repairId: harness.context.repairId,
    },
  });
  assert.equal(dryRun.mode, "rollback-dry-run");
  assert.equal(dryRun.writesPerformed, false);
  assert.equal(harness.replacementCount(), 1);

  const result = await rollbackRepair({
    db: harness.db,
    reservationCollection: harness.reservationCollection,
    manifestCollection: harness.manifestCollection,
    args: {
      apply: true,
      rollback: true,
      repairId: harness.context.repairId,
    },
    tokenFactory: () => "rollback-token-unit-test",
  });
  assert.equal(result.ok, true);
  assert.equal(result.writeAcknowledgementRecovered, true);
  assert.equal(result.manifestAcknowledgementRecovered, true);
  assert.equal(harness.replacementCount(), 2, "Rollback write was retried.");
  assert.equal(
    canonicalEjsonSha256(harness.storedReservation()),
    harness.plan.originalHash
  );
  const manifest = await harness.manifestCollection.findOne({
    _id: harness.context.repairId,
  });
  assert.equal(manifest.state, "rolled_back");
  assert.equal(manifest.verifiedOriginalHash, harness.plan.originalHash);
});

test("rollback refuses a live document changed after repair", async () => {
  const harness = maintenanceHarness();
  await applyRepair({
    db: harness.db,
    reservationCollection: harness.reservationCollection,
    manifestCollection: harness.manifestCollection,
    plan: harness.plan,
    context: harness.context,
    tokenFactory: () => "apply-token-unit-test",
  });
  const changed = harness.storedReservation();
  changed.customer_details.name = "legitimate later edit";
  harness.setStoredReservation(changed);
  await assert.rejects(
    rollbackRepair({
      db: harness.db,
      reservationCollection: harness.reservationCollection,
      manifestCollection: harness.manifestCollection,
      args: {
        apply: true,
        rollback: true,
        repairId: harness.context.repairId,
      },
      tokenFactory: () => "rollback-token-unit-test",
    }),
    /rollback is unsafe/
  );
  assert.equal(harness.replacementCount(), 1);
  const manifest = await harness.manifestCollection.findOne({
    _id: harness.context.repairId,
  });
  assert.equal(manifest.state, "applied");
});
