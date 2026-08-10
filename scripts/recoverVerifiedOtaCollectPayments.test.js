/** @format */

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  Binary,
  Decimal128,
  Double,
  Long,
  ObjectId,
  serialize,
} = require("bson");

const {
  BACKUP_COLLECTION,
  COLLECTIONS,
  MANIFEST_COLLECTION,
  applyPlan,
  backupRecord,
  buildFullDocumentCasFilter,
  cloneBson,
  createMutationCapability,
  loadPlan,
  main,
  manifestDocument,
  parseArguments,
  parseProof,
  proofToken,
  protectedReservationSnapshot,
  sha256,
} = require("./recoverVerifiedOtaCollectPayments");
const {
  buildAuthenticatedProviderCommercialEvidence,
} = require("../services/otaCommercialEvidence");
const {
  canonicalEjsonSha256,
} = require("../services/tripHotelRunnerRepair20260805");
const {
  createArchiveFingerprint,
} = require("../services/hotelrunnerFirstOtaFallback");

const RELEASE_SHA = "a".repeat(40);
const EXECUTION = Object.freeze({
  releaseSha: RELEASE_SHA,
  treeSha: "b".repeat(40),
  executionFingerprint: "c".repeat(64),
  trackedWorktreeClean: true,
});
const PLANNED_AT = new Date("2026-08-10T12:00:00.000Z");
const CLOCK = () => new Date("2026-08-10T12:00:01.000Z");

const id = (value) => String(value?._id || value || "");
const objectId = (number) =>
  new ObjectId(Number(number).toString(16).padStart(24, "0"));

function getPath(object, pathText) {
  return String(pathText)
    .split(".")
    .reduce(
      (current, key) => (current == null ? undefined : current[key]),
      object
    );
}

function setPath(object, pathText, value) {
  const parts = String(pathText).split(".");
  let current = object;
  for (const part of parts.slice(0, -1)) {
    if (!current[part] || typeof current[part] !== "object") current[part] = {};
    current = current[part];
  }
  current[parts.at(-1)] = cloneBson(value);
}

function sameValue(left, right) {
  if (left instanceof ObjectId || right instanceof ObjectId)
    return id(left) === id(right);
  if (left instanceof Date || right instanceof Date) {
    return new Date(left).getTime() === new Date(right).getTime();
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    return canonicalEjsonSha256(left) === canonicalEjsonSha256(right);
  }
  return left === right;
}

function matches(document, filter) {
  if (!filter || typeof filter !== "object") return true;
  if (Array.isArray(filter.$and)) {
    return filter.$and.every((entry) => {
      if (entry?.$expr) {
        const rootKeys = Object.keys(document).sort();
        const expectedSize = entry.$expr?.$and?.[0]?.$eq?.[1];
        const expectedKeys = entry.$expr?.$and?.[1]?.$setEquals?.[1];
        return (
          rootKeys.length === expectedSize &&
          canonicalEjsonSha256(rootKeys) === canonicalEjsonSha256(expectedKeys)
        );
      }
      return matches(document, entry);
    });
  }
  return Object.entries(filter).every(([key, expected]) => {
    if (["$and", "$expr"].includes(key)) return true;
    const actual = getPath(document, key);
    if (
      expected &&
      typeof expected === "object" &&
      !(expected instanceof ObjectId) &&
      !(expected instanceof Date) &&
      !Array.isArray(expected) &&
      Object.prototype.hasOwnProperty.call(expected, "$exists")
    ) {
      return (actual !== undefined) === expected.$exists;
    }
    return sameValue(actual, expected);
  });
}

class MemoryCollection {
  constructor(
    name,
    documents = [],
    database,
    { replaceHook = null, updateHook = null } = {}
  ) {
    this.name = name;
    this.documents = documents.map(cloneBson);
    this.database = database;
    this.replaceHook = replaceHook;
    this.updateHook = updateHook;
    this.replaceCalls = 0;
    this.updateCalls = 0;
  }

  find(filter) {
    const documents = this.documents
      .filter((document) => matches(document, filter))
      .map(cloneBson);
    return {
      limit(limit) {
        return {
          async toArray() {
            return documents.slice(0, limit);
          },
        };
      },
    };
  }

  async findOne(filter) {
    const found = this.documents.find((document) => matches(document, filter));
    return found ? cloneBson(found) : null;
  }

  async insertOne(document, options) {
    this.database.writeEvents.push({
      collection: this.name,
      kind: "insertOne",
      options,
    });
    if (
      this.documents.some((candidate) => sameValue(candidate._id, document._id))
    ) {
      const error = new Error("duplicate key");
      error.code = 11000;
      throw error;
    }
    this.documents.push(cloneBson(document));
    return { acknowledged: true, insertedId: document._id };
  }

  async updateOne(filter, update, options) {
    this.database.writeEvents.push({
      collection: this.name,
      kind: "updateOne",
      options,
    });
    this.updateCalls += 1;
    const commit = () => {
      const document = this.documents.find((candidate) =>
        matches(candidate, filter)
      );
      if (!document)
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
      for (const [pathText, value] of Object.entries(update.$set || {})) {
        setPath(document, pathText, value);
      }
      return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
    };
    if (this.updateHook) {
      return this.updateHook({
        call: this.updateCalls,
        commit,
        filter,
        update,
      });
    }
    return commit();
  }

  async replaceOne(filter, replacement, options) {
    this.database.writeEvents.push({
      collection: this.name,
      kind: "replaceOne",
      options,
    });
    this.replaceCalls += 1;
    const index = this.documents.findIndex((document) =>
      matches(document, filter)
    );
    const commit = () => {
      if (index < 0)
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
      this.documents[index] = cloneBson(replacement);
      return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
    };
    if (this.replaceHook) {
      return this.replaceHook({
        call: this.replaceCalls,
        commit,
        filter,
        replacement,
      });
    }
    return commit();
  }
}

function memoryDb(
  fixtures,
  { replaceHook = null, manifestUpdateHook = null } = {}
) {
  const database = {
    collections: new Map(),
    writeEvents: [],
    collection(name) {
      if (!this.collections.has(name)) {
        this.collections.set(name, new MemoryCollection(name, [], this));
      }
      return this.collections.get(name);
    },
    admin() {
      return {
        async command(command) {
          assert.deepEqual(command, { hello: 1 });
          return { isWritablePrimary: true, secondary: false };
        },
      };
    },
  };
  const sources = {
    [COLLECTIONS.reservations]: fixtures.map((fixture) => fixture.reservation),
    [COLLECTIONS.audits]: fixtures.map((fixture) => fixture.audit),
    [COLLECTIONS.jobs]: fixtures.map((fixture) => fixture.job),
    [COLLECTIONS.events]: fixtures.map((fixture) => fixture.event),
    [COLLECTIONS.mirrors]: fixtures.map((fixture) => fixture.mirror),
    [BACKUP_COLLECTION]: [],
    [MANIFEST_COLLECTION]: [],
  };
  for (const [name, documents] of Object.entries(sources)) {
    database.collections.set(
      name,
      new MemoryCollection(name, documents, database, {
        replaceHook: name === COLLECTIONS.reservations ? replaceHook : null,
        updateHook: name === MANIFEST_COLLECTION ? manifestUpdateHook : null,
      })
    );
  }
  return database;
}

function emptyPaidBreakdown() {
  return {
    paid_online_via_link: 0,
    paid_at_hotel_cash: 0,
    paid_at_hotel_card: 0,
    paid_to_hotel: 0,
    paid_online_jannatbooking: 0,
    paid_online_other_platforms: 0,
    paid_online_via_instapay: 0,
    paid_no_show: 0,
    payment_comments: "",
  };
}

function fixture({
  index = 1,
  provider = "futureota",
  gross = 125.5,
  payout = 88.25,
} = {}) {
  const reservationId = objectId(1000 + index * 10);
  const auditId = objectId(1001 + index * 10);
  const jobId = objectId(1002 + index * 10);
  const eventId = objectId(1003 + index * 10);
  const mirrorId = objectId(1004 + index * 10);
  const hotelId = objectId(7000 + index);
  const belongsTo = objectId(8000 + index);
  const pmsConfirmation = `pms-${provider}-${index}`;
  const externalConfirmation = `ota-${provider}-${index}`;
  const hotelRunnerReservationId = `hr-${provider}-${index}`;
  const bodyText = [
    "Authenticated OTA reservation advice",
    `provider=${provider}`,
    `confirmation=${externalConfirmation}`,
    `guestGross=${gross} SAR`,
    `hotelPayout=${payout} SAR`,
    "payment=OTA collect / paid online",
  ].join("\n");
  const evidence = buildAuthenticatedProviderCommercialEvidence({
    provider,
    authenticatedProvider: provider,
    sourceAuthenticated: true,
    sourceTrusted: true,
    sourceType: "authenticated_ota_email",
    sourceCurrency: "SAR",
    propertyCurrency: "SAR",
    bookingBasis: "reservation_total",
    sourceHash: sha256(bodyText),
    sourceTimestamp: "2026-08-10T10:00:00.000Z",
    sourceId: id(auditId),
    guestGross: { verified: true, amount: gross },
    hotelPayout: { verified: true, amount: payout },
  });
  const normalizedReservation = {
    provider,
    providerLabel: provider,
    bookingSource: provider,
    confirmationNumber: externalConfirmation,
    paymentCollectionModel: "ota_collect",
    paidOnline: true,
    paymentInstructions: `${provider} collected payment online`,
    totalAmountSar: gross,
    totalPayoutSar: payout,
    paymentSummary: {
      totalGuestPaymentAmount: gross,
      totalPayoutAmount: payout,
      currency: "SAR",
    },
    sourcePresence: { paymentCollectionModel: true },
  };
  const auditBase = {
    _id: auditId,
    hotelId,
    provider,
    confirmationNumber: externalConfirmation,
    bodyText,
    emailHash: "e".repeat(64),
    intent: "new_reservation",
    eventType: "new",
    paymentCollectionModel: "ota_collect",
    senderAuthentication: {
      authenticatedAligned: true,
      trustedProvider: provider,
    },
    hotelRunnerFirstFallback: {
      status: "completed_api",
      jobId,
      resolvedHotelProof: {
        version: 1,
        hotelId,
        belongsTo,
        currency: "SAR",
        activateHotel: true,
        xHotelProActive: true,
      },
    },
    normalizedReservation,
    parseErrors: [],
    reconcileErrors: [],
  };
  const archive = createArchiveFingerprint({
    identity: {
      hotelId: id(hotelId),
      provider,
      confirmationNumber: externalConfirmation,
    },
    audit: auditBase,
  });
  const financialCycle = {
    collectionModel: "pending",
    status: "open",
    commissionType: "amount",
    commissionValue: 0,
    commissionAmount: 0,
    commissionAssigned: false,
    commissionAssignedAt: null,
    commissionAssignedBy: null,
    pmsCollectedAmount: 0,
    hotelCollectedAmount: 0,
    hotelPayoutDue: 0,
    commissionDueToPms: 0,
    closedAt: null,
    closedBy: null,
    notes: "",
    lastUpdatedAt: new Date("2026-08-10T10:05:00.000Z"),
    lastUpdatedBy: null,
  };
  const reservation = {
    _id: reservationId,
    __v: 2,
    hotelId,
    belongsTo,
    confirmation_number: pmsConfirmation,
    reservation_id: externalConfirmation,
    otaIdentityKey: `${provider}:${externalConfirmation}`,
    booking_source: provider,
    customer_details: {
      name: "Safe Test Guest",
      confirmation_number2: externalConfirmation,
      booking_source: provider,
    },
    state: "ota platform review",
    reservation_status: "ota platform review",
    checkin_date: new Date("2026-09-01T00:00:00.000Z"),
    checkout_date: new Date("2026-09-03T00:00:00.000Z"),
    pickedRoomsType: [
      { room_type: "doubleRooms", count: 1, immutableMarker: index },
    ],
    pickedRoomsPricing: [
      {
        room_type: "doubleRooms",
        pricingByDay: [
          { date: "2026-09-01", clientPrice: gross / 2, rootPrice: 50 },
          { date: "2026-09-02", clientPrice: gross / 2, rootPrice: 50 },
        ],
      },
    ],
    total_amount: gross,
    sub_total: 100,
    commission: 0,
    currency: "SAR",
    payment: "not provided",
    financeStatus: "not paid",
    paid_amount: 0,
    payment_details: { captured: false, onsite_paid_amount: 0 },
    paid_amount_breakdown: emptyPaidBreakdown(),
    financial_cycle: financialCycle,
    vcc_payment: { charged: false, processing: false },
    braintree_payment: {},
    bofa_payment: {
      vcc: { charged: false, processing: false },
      secure_acceptance: { status: "not_started", currency: "USD" },
    },
    moneyTransferredToHotel: false,
    commissionPaid: false,
    adminPricing: {
      clientTotal: gross,
      rootTotal: 100,
      immutableMarker: index,
    },
    ota_financial_summary: {
      clientTotal: gross,
      paymentSummary: { totalGuestPaymentAmount: gross },
      immutableMarker: index,
    },
    otaPlatformReview: {
      status: "released",
      releasedAt: new Date("2026-08-10T10:10:00.000Z"),
      releasedBy: objectId(9000 + index),
      pricingReview: { status: "approved", immutableMarker: index },
    },
    supplierData: {
      otaProvider: provider,
      otaConfirmationNumber: externalConfirmation,
      platformConfirmationNumber: externalConfirmation,
      suppliedBookingNo: externalConfirmation,
      otaSourceAuthority: 4,
      otaAutomationPipeline: "hotelrunner-background-worker",
      otaInboundEmailId: auditId,
      otaLastInboundEmailId: auditId,
      otaPaymentSummary: { totalGuestPaymentAmount: gross },
      otaCommercialEvidence: evidence,
      hotelRunner: {
        transport: "hotelrunner_api",
        reservationId: hotelRunnerReservationId,
        immutableMarker: index,
      },
      hotelRunnerFirstFallbackCommercialBridge: {
        version: 1,
        jobId,
        inboundEmailId: auditId,
        inboundEmailHash: archive.inboundEmailHash,
        normalizedReservationHash: archive.normalizedReservationHash,
        resolvedHotelProofHash: archive.resolvedHotelProofHash,
        archiveFingerprint: archive.archiveFingerprint,
      },
    },
    reservationAuditLog: [
      {
        at: new Date("2026-08-10T10:06:00.000Z"),
        source: "hotelrunner-api",
        action: "created-from-hotelrunner",
      },
    ],
  };
  const audit = auditBase;
  const job = {
    _id: jobId,
    hotelId,
    provider,
    confirmationNumber: externalConfirmation,
    lookupConfirmationNumber: archive.lookupConfirmationNumber,
    lookupConfirmationHash: archive.lookupConfirmationHash,
    inboundEmailHash: archive.inboundEmailHash,
    normalizedReservationHash: archive.normalizedReservationHash,
    resolvedHotelProofHash: archive.resolvedHotelProofHash,
    archiveFingerprint: archive.archiveFingerprint,
    status: "completed_api",
    lastDecision: "completed_api_with_email_commercial_evidence",
    lastErrorCode: "",
    lastErrorMessage: "",
    inboundEmailId: auditId,
    reservationMongoId: reservationId,
    hotelRunnerMirrorId: mirrorId,
    hotelRunnerEventId: eventId,
  };
  const event = {
    _id: eventId,
    mirrorId,
    reservationMongoId: reservationId,
    integrityConflict: false,
    result: { status: "created" },
  };
  const mirror = {
    _id: mirrorId,
    reservationMongoId: reservationId,
    hotelRunnerReservationId,
    providerNumber: externalConfirmation,
    projectionStatus: "created",
  };
  return {
    pmsConfirmation,
    externalConfirmation,
    reservation,
    audit,
    job,
    event,
    mirror,
  };
}

async function planFor(db, fixtures) {
  return loadPlan({
    db,
    confirmations: fixtures.map((entry) => entry.pmsConfirmation).sort(),
    releaseSha: RELEASE_SHA,
    execution: EXECUTION,
    plannedAt: PLANNED_AT,
  });
}

function capabilityFor(plan) {
  return createMutationCapability({
    plan,
    proofDetails: parseProof(proofToken(plan), CLOCK()),
    execution: EXECUTION,
    clock: CLOCK,
  });
}

test("arguments accept only an exact dynamic target set and dry-run proof", () => {
  assert.deepEqual(
    parseArguments([
      "--confirmation=PMS-B",
      "--confirmations=pms-a,PMS-B",
      `--release-sha=${RELEASE_SHA}`,
    ]),
    {
      apply: false,
      proof: "",
      releaseSha: RELEASE_SHA,
      confirmations: ["pms-a", "pms-b"],
    }
  );
  assert.throws(
    () =>
      parseArguments([
        "--confirmation=pms-a",
        `--release-sha=${RELEASE_SHA}`,
        "--apply",
      ]),
    (error) => error.code === "OTA_COLLECT_PAYMENT_PROOF_REQUIRED"
  );
  assert.throws(
    () =>
      parseArguments([
        "--confirmation=pms-a",
        `--release-sha=${RELEASE_SHA}`,
        "--provider=agoda",
      ]),
    (error) => error.code === "OTA_COLLECT_PAYMENT_ARGUMENT_INVALID"
  );
});

test("provider-generic plan requires the exact authenticated audit and linked HotelRunner graph", async () => {
  const target = fixture({ provider: "futureota" });
  const db = memoryDb([target]);
  const plan = await planFor(db, [target]);
  const scope = plan.scopes[0];

  assert.equal(plan.state, "ready");
  assert.equal(scope.provider, "futureota");
  assert.equal(scope.grossAmount, 125.5);
  assert.equal(scope.expected.payment, "paid online");
  assert.equal(scope.expected.financeStatus, "paid online");
  assert.equal(scope.expected.paid_amount, 125.5);
  assert.equal(
    Number(scope.expected.paid_amount_breakdown.paid_online_other_platforms),
    125.5
  );
  assert.equal(scope.expected.financial_cycle.collectionModel, "pms_collected");
  assert.equal(scope.expected.financial_cycle.pmsCollectedAmount, 125.5);
  assert.equal(scope.expected.financial_cycle.hotelPayoutDue, 100);
  assert.equal(
    scope.expected.supplierData.otaPaymentCollectionModel,
    "ota_collect"
  );
  assert.equal(scope.expected.__v, target.reservation.__v + 1);
  assert.equal(
    canonicalEjsonSha256(protectedReservationSnapshot(scope.expected)),
    canonicalEjsonSha256(protectedReservationSnapshot(target.reservation))
  );
  assert.equal(
    canonicalEjsonSha256(scope.expected.payment_details),
    canonicalEjsonSha256(target.reservation.payment_details)
  );
  assert.equal(
    scope.expected.reservationAuditLog.length,
    target.reservation.reservationAuditLog.length + 1
  );
  assert.equal(db.writeEvents.length, 0);
});

test("zero-value release commission assignment is accepted and preserved byte-for-byte", async () => {
  const target = fixture({ provider: "agoda" });
  const assignedAt = new Date("2026-08-10T10:09:00.000Z");
  const assignedBy = objectId(9901);
  Object.assign(target.reservation.financial_cycle, {
    commissionAssigned: true,
    commissionAssignedAt: assignedAt,
    commissionAssignedBy: assignedBy,
    lastUpdatedAt: assignedAt,
    lastUpdatedBy: assignedBy,
  });
  const beforeTuple = {
    commissionAssigned: target.reservation.financial_cycle.commissionAssigned,
    commissionAssignedAt:
      target.reservation.financial_cycle.commissionAssignedAt,
    commissionAssignedBy:
      target.reservation.financial_cycle.commissionAssignedBy,
    lastUpdatedAt: target.reservation.financial_cycle.lastUpdatedAt,
    lastUpdatedBy: target.reservation.financial_cycle.lastUpdatedBy,
  };
  const plan = await planFor(memoryDb([target]), [target]);
  const after = plan.scopes[0].expected.financial_cycle;
  assert.equal(plan.state, "ready");
  assert.equal(
    canonicalEjsonSha256({
      commissionAssigned: after.commissionAssigned,
      commissionAssignedAt: after.commissionAssignedAt,
      commissionAssignedBy: after.commissionAssignedBy,
      lastUpdatedAt: after.lastUpdatedAt,
      lastUpdatedBy: after.lastUpdatedBy,
    }),
    canonicalEjsonSha256(beforeTuple)
  );
  assert.equal(
    canonicalEjsonSha256(protectedReservationSnapshot(plan.scopes[0].expected)),
    canonicalEjsonSha256(protectedReservationSnapshot(target.reservation))
  );
});

test("planning fails closed on unverified collect semantics or settlement activity", async (t) => {
  await t.test(
    "paidOnline must be explicitly true in the authenticated source",
    async () => {
      const target = fixture();
      target.audit.normalizedReservation.paidOnline = false;
      await assert.rejects(
        planFor(memoryDb([target]), [target]),
        (error) => error.code === "OTA_COLLECT_PAYMENT_EVIDENCE_MISMATCH"
      );
    }
  );

  await t.test("a processor reference blocks automatic mutation", async () => {
    const target = fixture();
    target.reservation.braintree_payment = {
      status: "captured",
      transaction_id: "opaque-processor-reference",
    };
    await assert.rejects(
      planFor(memoryDb([target]), [target]),
      (error) => error.code === "OTA_COLLECT_PAYMENT_SETTLEMENT_ACTIVITY"
    );
  });

  await t.test(
    "a mismatched HotelRunner mirror cannot be recovered",
    async () => {
      const target = fixture();
      target.mirror.providerNumber = "another-ota-confirmation";
      await assert.rejects(
        planFor(memoryDb([target]), [target]),
        (error) => error.code === "OTA_COLLECT_PAYMENT_HOTELRUNNER_LINK_INVALID"
      );
    }
  );

  await t.test(
    "the paid-online claim is bound to the immutable archive hash",
    async () => {
      const target = fixture();
      target.audit.normalizedReservation.paymentInstructions =
        "mutated after the fallback archive was created";
      await assert.rejects(
        planFor(memoryDb([target]), [target]),
        (error) => error.code === "OTA_COLLECT_PAYMENT_HOTELRUNNER_LINK_INVALID"
      );
    }
  );

  await t.test(
    "unknown manual finance-cycle activity blocks recovery",
    async () => {
      const target = fixture();
      target.reservation.financial_cycle.manualReconciliationReference =
        "opaque-finance-reference";
      await assert.rejects(
        planFor(memoryDb([target]), [target]),
        (error) => error.code === "OTA_COLLECT_PAYMENT_SETTLEMENT_ACTIVITY"
      );
    }
  );

  await t.test(
    "inconsistent commission-assignment actor or timestamp blocks recovery",
    async () => {
      for (const mismatch of ["actor", "timestamp"]) {
        const target = fixture({ index: mismatch === "actor" ? 31 : 32 });
        const assignedAt = new Date("2026-08-10T10:09:00.000Z");
        const assignedBy = objectId(9931);
        Object.assign(target.reservation.financial_cycle, {
          commissionAssigned: true,
          commissionAssignedAt: assignedAt,
          commissionAssignedBy: assignedBy,
          lastUpdatedAt:
            mismatch === "timestamp"
              ? new Date("2026-08-10T10:09:01.000Z")
              : assignedAt,
          lastUpdatedBy: mismatch === "actor" ? objectId(9932) : assignedBy,
        });
        await assert.rejects(
          planFor(memoryDb([target]), [target]),
          (error) => error.code === "OTA_COLLECT_PAYMENT_SETTLEMENT_ACTIVITY"
        );
      }
    }
  );

  await t.test(
    "nonzero commission or settlement fields remain blocked",
    async () => {
      const mutations = [
        (target) => {
          target.reservation.commission = 1;
          target.reservation.financial_cycle.commissionValue = 1;
          target.reservation.financial_cycle.commissionAmount = 1;
        },
        (target) => {
          target.reservation.financial_cycle.commissionDueToPms = 1;
        },
        (target) => {
          target.reservation.financial_cycle.closedAt = new Date();
        },
      ];
      for (const [index, mutate] of mutations.entries()) {
        const target = fixture({ index: 33 + index });
        mutate(target);
        await assert.rejects(
          planFor(memoryDb([target]), [target]),
          (error) => error.code === "OTA_COLLECT_PAYMENT_SETTLEMENT_ACTIVITY"
        );
      }
    }
  );
});

test("main dry-run performs zero writes and emits an apply-bound proof", async () => {
  const target = fixture();
  const db = memoryDb([target]);
  const originalLog = console.log;
  console.log = () => {};
  try {
    const result = await main(
      [
        `--confirmation=${target.pmsConfirmation}`,
        `--release-sha=${RELEASE_SHA}`,
      ],
      {
        clock: () => new Date(PLANNED_AT),
        attestExecution: () => EXECUTION,
        db,
        skipConnect: true,
      }
    );
    assert.equal(result.state, "dry_run_ready");
    assert.equal(result.proof, proofToken(result.plan));
    assert.equal(db.writeEvents.length, 0);
  } finally {
    console.log = originalLog;
  }
});

test("apply creates a durable full backup, majority-CASes only payment state, and is idempotent", async () => {
  const target = fixture({ provider: "booking", gross: 210, payout: 160 });
  const db = memoryDb([target]);
  const original = cloneBson(target.reservation);
  const plan = await planFor(db, [target]);
  const capability = capabilityFor(plan);
  const applied = await applyPlan(db, plan, capability);

  assert.deepEqual(applied, {
    state: "applied",
    changed: 1,
    vendorApiCalls: 0,
  });
  const live = await db
    .collection(COLLECTIONS.reservations)
    .findOne({ _id: original._id });
  assert.equal(canonicalEjsonSha256(live), plan.scopes[0].expectedHash);
  assert.equal(Number(live.paid_amount), 210);
  assert.equal(
    Number(live.paid_amount_breakdown.paid_online_other_platforms),
    210
  );
  assert.equal(Number(live.financial_cycle.pmsCollectedAmount), 210);
  assert.equal(live.payment_details.captured, false);
  assert.equal(
    canonicalEjsonSha256(live.pickedRoomsPricing),
    canonicalEjsonSha256(original.pickedRoomsPricing)
  );
  assert.equal(
    canonicalEjsonSha256(live.otaPlatformReview),
    canonicalEjsonSha256(original.otaPlatformReview)
  );
  assert.equal(
    canonicalEjsonSha256(live.adminPricing),
    canonicalEjsonSha256(original.adminPricing)
  );

  const backups = db.collection(BACKUP_COLLECTION).documents;
  assert.equal(backups.length, 1);
  assert.equal(
    canonicalEjsonSha256(backups[0].originalDocument),
    canonicalEjsonSha256(original)
  );
  assert.equal(backups[0].originalHash, canonicalEjsonSha256(original));
  const manifest = await db
    .collection(MANIFEST_COLLECTION)
    .findOne({ _id: plan.planHash });
  assert.equal(manifest.state, "applied");
  assert.ok(
    db.writeEvents.every(
      (event) => event.options?.writeConcern?.w === "majority"
    ),
    "every insert, update, and replacement must use majority write concern"
  );

  const repeated = await applyPlan(db, plan, capability);
  assert.deepEqual(repeated, {
    state: "already_applied",
    changed: 0,
    vendorApiCalls: 0,
  });
  assert.equal(
    canonicalEjsonSha256(
      await db
        .collection(COLLECTIONS.reservations)
        .findOne({ _id: original._id })
    ),
    plan.scopes[0].expectedHash
  );
});

test("a committed final-manifest write with a lost acknowledgement is read back as applied", async () => {
  const target = fixture();
  const db = memoryDb([target], {
    manifestUpdateHook: ({ commit, update }) => {
      if (update?.$set?.state === "applied") {
        commit();
        throw new Error("injected lost acknowledgement after commit");
      }
      return commit();
    },
  });
  const plan = await planFor(db, [target]);
  const result = await applyPlan(db, plan, capabilityFor(plan));
  assert.deepEqual(result, { state: "applied", changed: 1, vendorApiCalls: 0 });
  assert.equal(
    canonicalEjsonSha256(
      await db.collection(COLLECTIONS.reservations).findOne({
        _id: target.reservation._id,
      })
    ),
    plan.scopes[0].expectedHash
  );
  assert.equal(
    (await db.collection(MANIFEST_COLLECTION).findOne({ _id: plan.planHash }))
      .state,
    "applied"
  );
});

test("apply revalidates the full authenticated source graph immediately before CAS", async () => {
  const target = fixture();
  const db = memoryDb([target]);
  const plan = await planFor(db, [target]);
  const originalHash = canonicalEjsonSha256(target.reservation);
  db.collection(
    COLLECTIONS.audits
  ).documents[0].normalizedReservation.paymentInstructions =
    "changed after dry run";
  await assert.rejects(applyPlan(db, plan, capabilityFor(plan)), (error) => {
    assert.equal(error.compensated, true);
    return true;
  });
  assert.equal(
    canonicalEjsonSha256(
      await db.collection(COLLECTIONS.reservations).findOne({
        _id: target.reservation._id,
      })
    ),
    originalHash
  );
});

test("an interrupted subset is resumed from the old manifest and full backup", async () => {
  const target = fixture();
  const db = memoryDb([target]);
  const plan = await planFor(db, [target]);
  const manifest = manifestDocument(plan);
  Object.assign(manifest, {
    state: "applying",
    applyOwnerToken: "abandoned-owner",
    applyLeaseUntil: new Date("2026-08-10T12:00:05.000Z"),
    applyingAt: new Date("2026-08-10T12:00:00.000Z"),
  });
  await db.collection(MANIFEST_COLLECTION).insertOne(manifest, {
    writeConcern: { w: "majority" },
  });
  await db
    .collection(BACKUP_COLLECTION)
    .insertOne(backupRecord(plan, plan.scopes[0]), {
      writeConcern: { w: "majority" },
    });
  db.collection(COLLECTIONS.reservations).documents[0] = cloneBson(
    plan.scopes[0].expected
  );
  const originalLog = console.log;
  console.log = () => {};
  try {
    const result = await main(
      [
        `--confirmation=${target.pmsConfirmation}`,
        `--release-sha=${RELEASE_SHA}`,
        "--apply",
        `--proof=${proofToken(plan)}`,
      ],
      {
        clock: () => new Date("2026-08-10T12:00:10.000Z"),
        attestExecution: () => EXECUTION,
        db,
        skipConnect: true,
      }
    );
    assert.deepEqual(result, {
      state: "applied",
      changed: 0,
      vendorApiCalls: 0,
    });
    assert.equal(
      (await db.collection(MANIFEST_COLLECTION).findOne({ _id: plan.planHash }))
        .state,
      "applied"
    );
  } finally {
    console.log = originalLog;
  }
});

test("full-document CAS rejects nested null-versus-missing drift", async () => {
  const target = fixture();
  target.reservation.protectedNullShape = {
    presentNull: null,
    nested: { presentNull: null, marker: "kept" },
  };
  const db = memoryDb([target]);
  const before = await db.collection(COLLECTIONS.reservations).findOne({
    _id: target.reservation._id,
  });
  const foreign = cloneBson(before);
  delete foreign.protectedNullShape.nested.presentNull;
  foreign.protectedNullShape.nested.otherNull = null;
  const replacement = cloneBson(before);
  replacement.state = "must-not-commit";
  const collection = db.collection(COLLECTIONS.reservations);
  collection.documents[0] = foreign;
  const result = await collection.replaceOne(
    buildFullDocumentCasFilter(before),
    replacement,
    { writeConcern: { w: "majority" } }
  );
  assert.equal(result.matchedCount, 0);
  assert.equal(collection.documents[0].state, foreign.state);
});

test("a later CAS failure compensates every earlier replacement byte-for-byte", async () => {
  const first = fixture({
    index: 1,
    provider: "agoda",
    gross: 95,
    payout: 58.78,
  });
  const second = fixture({
    index: 2,
    provider: "agoda",
    gross: 385,
    payout: 238.22,
  });
  first.reservation.protectedExoticBson = {
    long: Long.fromString("9223372036854775000"),
    decimal: Decimal128.fromString("12345.6700"),
    double: new Double(1),
    binary: new Binary(Buffer.from([0, 1, 2, 253, 254, 255]), 0x80),
    presentNull: null,
    nested: { presentNull: null },
  };
  const originals = [first, second].map((target) =>
    cloneBson(target.reservation)
  );
  const db = memoryDb([first, second], {
    replaceHook: ({ call, commit }) => {
      if (call === 2) throw new Error("injected second-target CAS failure");
      return commit();
    },
  });
  const plan = await planFor(db, [first, second]);
  const capability = capabilityFor(plan);

  await assert.rejects(applyPlan(db, plan, capability), (error) => {
    assert.equal(error.code, "OTA_COLLECT_PAYMENT_CAS_REJECTED");
    assert.equal(error.compensated, true);
    return true;
  });
  for (const original of originals) {
    const live = await db
      .collection(COLLECTIONS.reservations)
      .findOne({ _id: original._id });
    assert.equal(canonicalEjsonSha256(live), canonicalEjsonSha256(original));
    assert.deepEqual(serialize(live), serialize(original));
  }
  const restored = await db.collection(COLLECTIONS.reservations).findOne({
    _id: first.reservation._id,
  });
  assert.ok(restored.protectedExoticBson.long instanceof Long);
  assert.ok(restored.protectedExoticBson.decimal instanceof Decimal128);
  assert.ok(restored.protectedExoticBson.double instanceof Double);
  assert.ok(restored.protectedExoticBson.binary instanceof Binary);
  assert.equal(restored.protectedExoticBson.binary.sub_type, 0x80);
  assert.equal(restored.protectedExoticBson.nested.presentNull, null);
  const manifest = await db
    .collection(MANIFEST_COLLECTION)
    .findOne({ _id: plan.planHash });
  assert.equal(manifest.state, "compensated");
  assert.equal(db.collection(BACKUP_COLLECTION).documents.length, 2);
});

test("source drift after the first write cannot prevent exact backup compensation", async () => {
  const first = fixture({
    index: 11,
    provider: "agoda",
    gross: 101,
    payout: 70,
  });
  const second = fixture({
    index: 12,
    provider: "agoda",
    gross: 202,
    payout: 140,
  });
  const originals = [first, second].map((target) =>
    cloneBson(target.reservation)
  );
  let db;
  db = memoryDb([first, second], {
    replaceHook: ({ call, commit }) => {
      const result = commit();
      if (call === 1) {
        const audits = db.collection(COLLECTIONS.audits).documents;
        for (const audit of audits) {
          audit.normalizedReservation.paymentInstructions =
            "source drift injected after the first reservation CAS";
        }
      }
      return result;
    },
  });
  const plan = await planFor(db, [first, second]);

  await assert.rejects(applyPlan(db, plan, capabilityFor(plan)), (error) => {
    assert.equal(error.compensated, true);
    return true;
  });
  for (const original of originals) {
    const live = await db.collection(COLLECTIONS.reservations).findOne({
      _id: original._id,
    });
    assert.deepEqual(serialize(live), serialize(original));
  }
  const manifest = await db.collection(MANIFEST_COLLECTION).findOne({
    _id: plan.planHash,
  });
  assert.equal(manifest.state, "compensated");
});

test("resumed expected scope is restored when a later scope fails before a new write", async () => {
  const first = fixture({
    index: 21,
    provider: "agoda",
    gross: 111,
    payout: 71,
  });
  const second = fixture({
    index: 22,
    provider: "agoda",
    gross: 222,
    payout: 142,
  });
  const originals = [first, second].map((target) =>
    cloneBson(target.reservation)
  );
  const db = memoryDb([first, second]);
  const plan = await planFor(db, [first, second]);
  const manifest = manifestDocument(plan);
  Object.assign(manifest, {
    state: "applying",
    applyOwnerToken: "abandoned-owner",
    applyLeaseUntil: new Date("2026-08-10T11:59:00.000Z"),
    applyingAt: new Date("2026-08-10T11:58:00.000Z"),
  });
  await db.collection(MANIFEST_COLLECTION).insertOne(manifest, {
    writeConcern: { w: "majority" },
  });
  for (const scope of plan.scopes) {
    await db
      .collection(BACKUP_COLLECTION)
      .insertOne(backupRecord(plan, scope), {
        writeConcern: { w: "majority" },
      });
  }
  const firstScope = plan.scopes.find(
    (scope) => scope.pmsConfirmation === first.pmsConfirmation
  );
  db.collection(COLLECTIONS.reservations).documents[0] = cloneBson(
    firstScope.expected
  );
  const secondAudit = db
    .collection(COLLECTIONS.audits)
    .documents.find((audit) => id(audit._id) === id(second.audit._id));
  secondAudit.normalizedReservation.paymentInstructions =
    "source drift before resumed second target";

  await assert.rejects(applyPlan(db, plan, capabilityFor(plan)), (error) => {
    assert.equal(error.compensated, true);
    return true;
  });
  for (const original of originals) {
    const live = await db.collection(COLLECTIONS.reservations).findOne({
      _id: original._id,
    });
    assert.deepEqual(serialize(live), serialize(original));
  }
  assert.equal(
    (await db.collection(MANIFEST_COLLECTION).findOne({ _id: plan.planHash }))
      .state,
    "compensated"
  );
});

test("foreign later scope cannot prevent restoration of every earlier expected scope", async () => {
  const first = fixture({
    index: 41,
    provider: "agoda",
    gross: 131,
    payout: 81,
  });
  const second = fixture({
    index: 42,
    provider: "agoda",
    gross: 262,
    payout: 162,
  });
  const firstOriginal = cloneBson(first.reservation);
  let secondForeignHash = "";
  let db;
  db = memoryDb([first, second], {
    replaceHook: ({ call, commit }) => {
      const result = commit();
      if (call === 1) {
        const secondLive = db
          .collection(COLLECTIONS.reservations)
          .documents.find(
            (reservation) => id(reservation._id) === id(second.reservation._id)
          );
        secondLive.concurrentForeignMarker = {
          actor: "independent-finance-process",
          at: new Date("2026-08-10T12:00:01.500Z"),
        };
        secondForeignHash = canonicalEjsonSha256(secondLive);
      }
      return result;
    },
  });
  const plan = await planFor(db, [first, second]);

  await assert.rejects(applyPlan(db, plan, capabilityFor(plan)), (error) => {
    assert.equal(
      error.code,
      "OTA_COLLECT_PAYMENT_MANUAL_INTERVENTION_REQUIRED"
    );
    assert.ok(
      error.compensationResults.some(
        (entry) =>
          entry.pmsConfirmation === first.pmsConfirmation &&
          entry.state === "restored" &&
          entry.changed === true
      )
    );
    assert.ok(
      error.compensationIssues.some(
        (entry) =>
          entry.pmsConfirmation === second.pmsConfirmation &&
          entry.reason === "foreign_or_missing_state" &&
          entry.observedState === "foreign"
      )
    );
    return true;
  });

  const firstLive = await db
    .collection(COLLECTIONS.reservations)
    .findOne({ _id: first.reservation._id });
  const secondLive = await db
    .collection(COLLECTIONS.reservations)
    .findOne({ _id: second.reservation._id });
  assert.deepEqual(serialize(firstLive), serialize(firstOriginal));
  assert.equal(canonicalEjsonSha256(secondLive), secondForeignHash);
  assert.equal(
    secondLive.concurrentForeignMarker.actor,
    "independent-finance-process"
  );

  const manifest = await db.collection(MANIFEST_COLLECTION).findOne({
    _id: plan.planHash,
  });
  assert.equal(manifest.state, "manual_intervention_required");
  assert.ok(
    manifest.compensation.some(
      (entry) =>
        entry.pmsConfirmation === first.pmsConfirmation &&
        entry.state === "restored"
    )
  );
  assert.ok(
    manifest.manualInterventionIssues.some(
      (entry) =>
        entry.pmsConfirmation === second.pmsConfirmation &&
        entry.observedState === "foreign"
    )
  );
});
