/** @format */

"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const { ObjectId } = require("bson");

const v1 = require("./repairExpediaCommercialEnrichment20260809");
const repairModulePath = require.resolve(
  "./repairExpediaCommercialMaterialization20260809"
);
const repairApi = require(repairModulePath);
const {
  BACKUP_COLLECTION,
  COLLECTIONS,
  MANIFEST_COLLECTION,
  REPAIR_ID,
  TARGET,
  allocateCentsByWeight,
  applyRepairPlan,
  applyRollbackPlan,
  assertTrustedConversion,
  loadPlan,
  loadRollbackPlan,
  main: productionMain,
  parseArguments,
  proofToken,
  sanitizedForwardOutput,
  verifyBackupRecords,
} = repairApi;

function loadTestOnlyMain() {
  const testModule = new Module(repairModulePath + ".test-internal", module);
  testModule.filename = repairModulePath;
  testModule.paths = Module._nodeModulePaths(path.dirname(repairModulePath));
  const source = fs.readFileSync(repairModulePath, "utf8");
  testModule._compile(
    source + "\nmodule.exports.__runMainForTests = runMainWithDependencies;\n",
    repairModulePath
  );
  return testModule.exports.__runMainForTests;
}

const main = loadTestOnlyMain();
const {
  canonicalEjsonSha256,
  cloneBson,
} = require("../services/recentOtaInboundRecovery20260805");

const RELEASE_SHA = "c".repeat(40);
const TREE_SHA = "d".repeat(40);
const EXECUTION_FINGERPRINT = "e".repeat(64);
const CLEAN_EXECUTION = Object.freeze({
  releaseSha: RELEASE_SHA,
  treeSha: TREE_SHA,
  executionFingerprint: EXECUTION_FINGERPRINT,
  trackedWorktreeClean: true,
});
const V1_RELEASE_SHA = "a".repeat(40);
const V1_PLANNED_AT = new Date("2026-08-09T04:15:00.000Z");
const OWNER_ID = new ObjectId("68b74714fb50e159d48c714d");
const PORTAL_SELECTION = Object.freeze({
  jobId: "6a77f999cdbc8acbbe4968a6",
  jobNumber: "OTA-RES-SYNC-20260809120000-ABCDE",
});

const oid = (value) => new ObjectId(value);
const getPath = (document, pathText) =>
  String(pathText)
    .split(".")
    .reduce(
      (current, key) => (current == null ? undefined : current[key]),
      document
    );

function hasPath(document, pathText) {
  const parts = String(pathText).split(".");
  let current = document;
  for (const key of parts) {
    if (
      current == null ||
      typeof current !== "object" ||
      !Object.prototype.hasOwnProperty.call(current, key)
    ) {
      return false;
    }
    current = current[key];
  }
  return true;
}

function setPath(document, pathText, value) {
  const parts = String(pathText).split(".");
  let current = document;
  for (const part of parts.slice(0, -1)) {
    if (!current[part] || typeof current[part] !== "object") current[part] = {};
    current = current[part];
  }
  current[parts.at(-1)] = cloneBson(value);
}

function equal(left, right) {
  return canonicalEjsonSha256(left) === canonicalEjsonSha256(right);
}

function matches(document, filter = {}) {
  for (const [pathText, expected] of Object.entries(filter || {})) {
    if (pathText === "$and") {
      if (!expected.every((branch) => matches(document, branch))) return false;
      continue;
    }
    if (pathText === "$or") {
      if (!expected.some((branch) => matches(document, branch))) return false;
      continue;
    }
    if (pathText === "$expr") {
      const clauses = Array.isArray(expected?.$and)
        ? expected.$and
        : [expected];
      for (const clause of clauses) {
        if (clause?.$eq) {
          const expectedCount = clause.$eq[1];
          if (Object.keys(document || {}).length !== expectedCount)
            return false;
        }
        if (clause?.$setEquals) {
          const expectedKeys = clause.$setEquals[1];
          if (
            !Array.isArray(expectedKeys) ||
            Object.keys(document || {})
              .sort()
              .join("\u0000") !== [...expectedKeys].sort().join("\u0000")
          ) {
            return false;
          }
        }
      }
      continue;
    }
    const actual = getPath(document, pathText);
    if (
      expected &&
      typeof expected === "object" &&
      !Array.isArray(expected) &&
      Object.prototype.hasOwnProperty.call(expected, "$in")
    ) {
      if (!expected.$in.some((value) => equal(actual, value))) return false;
      continue;
    }
    if (
      expected &&
      typeof expected === "object" &&
      !Array.isArray(expected) &&
      Object.prototype.hasOwnProperty.call(expected, "$exists")
    ) {
      if (hasPath(document, pathText) !== expected.$exists) return false;
      continue;
    }
    if (expected === null) {
      if (actual !== null && actual !== undefined) return false;
      continue;
    }
    if (!equal(actual, expected)) return false;
  }
  return true;
}

class MemoryCollection {
  constructor(documents = [], db = null, name = "") {
    this.documents = documents.map(cloneBson);
    this.db = db;
    this.name = name;
    this.replaceCalls = 0;
    this.beforeReplace = null;
    this.afterReplace = null;
    this.beforeInsert = null;
    this.beforeFindOne = null;
  }

  documentsFor(options = {}) {
    return options?.session
      ? options.session.documentsFor(this)
      : this.documents;
  }

  markWrite(options = {}) {
    if (options?.session) options.session.markWrite(this);
  }

  find(filter, options = {}) {
    const collection = this;
    return {
      max: Infinity,
      limit(value) {
        this.max = value;
        return this;
      },
      async toArray() {
        return collection
          .documentsFor(options)
          .filter((document) => matches(document, filter))
          .slice(0, this.max)
          .map(cloneBson);
      },
    };
  }

  async findOne(filter, options = {}) {
    if (this.beforeFindOne) {
      await this.beforeFindOne({
        collection: this,
        filter: cloneBson(filter),
        options,
      });
    }
    const found = this.documentsFor(options).find((document) =>
      matches(document, filter)
    );
    return found ? cloneBson(found) : null;
  }

  async insertOne(document, options = {}) {
    if (this.beforeInsert) {
      await this.beforeInsert({
        collection: this,
        document: cloneBson(document),
      });
    }
    const documents = this.documentsFor(options);
    if (documents.some((candidate) => equal(candidate._id, document._id))) {
      throw new Error("duplicate key");
    }
    documents.push(cloneBson(document));
    this.markWrite(options);
    return { acknowledged: true, insertedId: document._id };
  }

  async replaceOne(filter, replacement, options = {}) {
    this.replaceCalls += 1;
    if (this.beforeReplace) {
      await this.beforeReplace({
        collection: this,
        filter: cloneBson(filter),
        replacement: cloneBson(replacement),
      });
    }
    const documents = this.documentsFor(options);
    const index = documents.findIndex((document) => matches(document, filter));
    if (index < 0) {
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
    }
    documents[index] = cloneBson(replacement);
    this.markWrite(options);
    if (this.afterReplace) {
      await this.afterReplace({
        collection: this,
        filter: cloneBson(filter),
        replacement: cloneBson(replacement),
      });
    }
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  }

  async updateOne(filter, update, options = {}) {
    const document = this.documentsFor(options).find((candidate) =>
      matches(candidate, filter)
    );
    if (!document)
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
    for (const [pathText, value] of Object.entries(update.$set || {})) {
      setPath(document, pathText, value);
    }
    this.markWrite(options);
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  }
}

class MemorySession {
  constructor(db) {
    this.db = db;
    this.active = false;
    this.startHashes = new Map();
    this.working = new Map();
    this.written = new Set();
  }

  documentsFor(collection) {
    if (!this.active || collection.db !== this.db) {
      throw new Error("invalid test transaction session");
    }
    if (!this.working.has(collection.name)) {
      this.startHashes.set(
        collection.name,
        canonicalEjsonSha256(collection.documents)
      );
      this.working.set(collection.name, cloneBson(collection.documents));
    }
    return this.working.get(collection.name);
  }

  markWrite(collection) {
    this.written.add(collection.name);
  }

  async withTransaction(work) {
    if (!this.db.transactionCapable) {
      throw new Error("transactions unavailable");
    }
    this.active = true;
    try {
      for (const [name, collection] of this.db.collections) {
        this.startHashes.set(name, canonicalEjsonSha256(collection.documents));
        this.working.set(name, cloneBson(collection.documents));
      }
      const result = await work();
      for (const name of this.written) {
        const collection = this.db.collection(name);
        if (
          canonicalEjsonSha256(collection.documents) !==
          this.startHashes.get(name)
        ) {
          throw new Error("WriteConflict");
        }
      }
      for (const name of this.written) {
        this.db.collection(name).documents = cloneBson(this.working.get(name));
      }
      return result;
    } finally {
      this.active = false;
    }
  }

  async endSession() {}
}

class MemoryDb {
  constructor(seed = {}) {
    this.isWritablePrimary = true;
    this.transactionCapable = true;
    this.collections = new Map();
    for (const [name, documents] of Object.entries(seed)) {
      this.collections.set(name, new MemoryCollection(documents, this, name));
    }
    this.client = {
      startSession: () => new MemorySession(this),
    };
  }

  collection(name) {
    if (!this.collections.has(name)) {
      this.collections.set(name, new MemoryCollection([], this, name));
    }
    return this.collections.get(name);
  }

  admin() {
    return {
      command: async () => {
        return {
          isWritablePrimary: this.isWritablePrimary,
          setName: this.transactionCapable ? "memory-rs" : undefined,
        };
      },
    };
  }
}

function v1NightlyRows() {
  return TARGET.dailyRoot.map((rootPrice, index) => {
    const date = new Date(TARGET.checkinDate + "T00:00:00.000Z");
    date.setUTCDate(date.getUTCDate() + index);
    const falseAmount = TARGET.dailyFalseCanonical[index];
    return {
      date: date.toISOString().slice(0, 10),
      price: falseAmount,
      clientPrice: falseAmount,
      mainPrice: falseAmount,
      rootPrice,
      commissionRate: 0,
      totalPriceWithCommission: falseAmount,
      totalPriceWithoutCommission: rootPrice,
      netAfterExpenses: falseAmount,
      netAfterOtaExpenses: falseAmount,
      otaExpenseAmount: 0,
      platformMargin: Number((falseAmount - rootPrice).toFixed(2)),
      commercialVerification: "unsafe_legacy_projection",
      hotelRunnerSourcePrice: TARGET.dailyHotelRunnerSource[index],
    };
  });
}

function v1Fixture() {
  const pricingByDay = v1NightlyRows();
  const room = {
    room_type: "doubleRooms",
    displayName: "Protected mapped room",
    hotelRoomConfigId: oid("6a40df5f1a6d1850eb25c183"),
    localRoomConfigId: oid("6a40df5f1a6d1850eb25c183"),
    hotelRunnerRoomId: "hr-room-1",
    count: 1,
    chosenPrice: 70.58,
    totalPriceWithCommission: TARGET.oldCanonicalClientTotal,
    hotelShouldGet: TARGET.rootTotal,
    pricingByDay,
  };
  const reservation = {
    _id: oid(TARGET.reservationMongoId),
    __v: TARGET.reservationVersion,
    createdAt: new Date("2026-08-09T02:15:00.000Z"),
    updatedAt: new Date("2026-08-09T02:16:00.000Z"),
    hotelId: oid(TARGET.hotelId),
    belongsTo: OWNER_ID,
    confirmation_number: TARGET.pmsConfirmationNumber,
    reservation_id: TARGET.otaBookingId,
    hr_number: TARGET.hrNumber.toLowerCase(),
    otaIdentityKey: TARGET.otaIdentityKey,
    otaCrossTransportIdentityKey: "",
    booking_source: "expedia",
    customer_details: {
      name: "PRIVATE TEST GUEST",
      confirmation_number2: TARGET.otaBookingId,
    },
    state: "confirmed",
    reservation_status: "confirmed",
    checkin_date: new Date(TARGET.checkinDate + "T00:00:00.000Z"),
    checkout_date: new Date(TARGET.checkoutDate + "T00:00:00.000Z"),
    days_of_residence: TARGET.nights,
    total_rooms: 1,
    total_guests: 2,
    adults: 2,
    children: 0,
    roomId: [],
    bedNumber: [],
    total_amount: TARGET.oldCanonicalClientTotal,
    sub_total: TARGET.rootTotal,
    currency: "sar",
    commission: 0,
    commission_ota: null,
    financeStatus: "not paid",
    payment: "bank transfer",
    paid_amount: 0,
    payment_details: { captured: false, onsite_paid_amount: 0 },
    bofa_payment: { vcc: { charged: false, secretSentinel: "must-survive" } },
    moneyTransferredToHotel: false,
    commissionPaid: false,
    pickedRoomsType: [cloneBson(room)],
    pickedRoomsPricing: [cloneBson(room)],
    adminPricing: {
      mode: "hotelrunner_api",
      clientTotal: TARGET.oldCanonicalClientTotal,
      rootTotal: TARGET.rootTotal,
      netAfterExpensesTotal: TARGET.oldCanonicalClientTotal,
      otaExpenseTotal: 0,
      platformMarginTotal: -110.55,
      commissionAmount: 0,
      commercialVerified: false,
      defaultDeductionRate: 0.1,
      defaultDeductionApplied: false,
      source: "ota_email_create",
      sourceCurrency: "USD",
      sourceAmount: TARGET.hotelRunnerReportedAmount,
      sourceExchangeRateToSar: 3.75,
      sourceExchangeRateSource: "fallback_default",
      exchangeRateToSar: 3.75,
      exchangeRateSource: "fallback_default",
      amountConvertedAt: new Date("2026-08-09T02:15:30.000Z"),
    },
    ota_financial_summary: {
      show: true,
      source: "ota_email_create",
      currency: "SAR",
      clientTotal: TARGET.oldCanonicalClientTotal,
      hotelVisibleAmount: TARGET.rootTotal,
      netAfterExpenses: TARGET.oldCanonicalClientTotal,
      netAfterOtaExpenses: TARGET.oldCanonicalClientTotal,
      otaExpenseTotal: 0,
      platformProfit: -110.55,
      commissionAmount: 0,
      otaCommissionAmount: null,
      commercialVerified: false,
      sourceExchangeRateToSar: 3.75,
      sourceExchangeRateSource: "fallback_default",
    },
    supplierData: {
      supplierName: "Expedia",
      suppliedBookingNo: TARGET.otaBookingId,
      otaConfirmationNumber: TARGET.otaBookingId,
      platformConfirmationNumber: TARGET.otaBookingId,
      otaProvider: "expedia",
      otaAmount: TARGET.hotelRunnerReportedAmount,
      otaAmountSar: TARGET.oldCanonicalClientTotal,
      otaAmountConvertedAt: new Date("2026-08-09T02:15:30.000Z"),
      otaCurrency: "USD",
      otaExchangeRateToSar: 3.75,
      otaExchangeRateSource: "exchange_rate_api_cached",
      otaSourceAmount: TARGET.hotelRunnerReportedAmount,
      otaSourceCurrency: "USD",
      otaSourceExchangeRateToSar: 3.75,
      otaSourceExchangeRateSource: "fallback_default",
      otaTotalPayoutSar: TARGET.oldCanonicalClientTotal,
      otaExpenseTotalSar: 0,
      otaPlatformMarginSar: -110.55,
      otaCommissionSar: null,
      otaDeductionComponents: [],
      otaPaymentCollectionModel: "ota_collect",
      otaPaymentSummary: {
        sourceCurrency: "USD",
        sourceTotalGuestPaymentAmount: TARGET.hotelRunnerReportedAmount,
        totalGuestPaymentAmount: TARGET.oldCanonicalClientTotal,
        exchangeRateSource: "fallback_default",
      },
      hotelRunner: {
        transport: "hotelrunner_api",
        reservationId: TARGET.hotelRunnerReservationId,
        hrNumber: TARGET.hrNumber,
        providerNumber: TARGET.otaBookingId,
        channel: "expedia",
        immutableRawSentinel: { untouched: true },
        pricing: {
          source: "hotelrunner_api",
          currency: "USD",
          grandTotal: TARGET.hotelRunnerReportedAmount,
          hotelNetPayout: null,
          otaCommission: null,
          rooms: [
            {
              currency: "USD",
              totalAfterTax: TARGET.hotelRunnerReportedAmount,
              nightly: TARGET.dailyHotelRunnerSource.map(
                (finalPrice, index) => {
                  const date = new Date(TARGET.checkinDate + "T00:00:00.000Z");
                  date.setUTCDate(date.getUTCDate() + index);
                  return {
                    date: date.toISOString().slice(0, 10),
                    finalPrice,
                  };
                }
              ),
            },
          ],
        },
      },
    },
    reservationAuditLog: [
      { at: new Date("2026-08-09T02:16:00.000Z"), action: "created" },
    ],
  };
  const event = {
    _id: oid(TARGET.eventId),
    __v: 0,
    hotelId: oid(TARGET.hotelId),
    eventKey: "push:exact-expedia-event",
    messageUid: "uid-exact-expedia-event",
    payloadHash: TARGET.eventPayloadHash,
    canonicalHash: TARGET.eventCanonicalHash,
    source: "push",
    hotelRunnerReservationId: TARGET.hotelRunnerReservationId,
    hrNumber: TARGET.hrNumber,
    providerNumber: TARGET.otaBookingId,
    channel: "expedia",
    state: "reserved",
    sourceUpdatedAt: new Date("2026-08-09T02:14:00.000Z"),
    payload: {
      reservation: {
        id: TARGET.hotelRunnerReservationId,
        provider_number: TARGET.otaBookingId,
        total: TARGET.hotelRunnerReportedAmount,
        currency: "USD",
      },
    },
    status: TARGET.eventStatus,
    integrityConflict: false,
    integrityReason: "",
    reservationMongoId: oid(TARGET.reservationMongoId),
    mirrorId: oid(TARGET.mirrorId),
    receivedAt: new Date("2026-08-09T02:14:01.000Z"),
  };
  const mirror = {
    _id: oid(TARGET.mirrorId),
    __v: 0,
    hotelId: oid(TARGET.hotelId),
    hrIdFingerprint: "a".repeat(64),
    hotelRunnerReservationId: TARGET.hotelRunnerReservationId,
    hrNumber: TARGET.hrNumber,
    providerNumber: TARGET.otaBookingId,
    channel: "expedia",
    state: "reserved",
    observedSourceUpdatedAt: new Date("2026-08-09T02:14:00.000Z"),
    observedCanonicalHash: TARGET.eventCanonicalHash,
    appliedCanonicalHash: TARGET.eventCanonicalHash,
    reservationMongoId: oid(TARGET.reservationMongoId),
    identityConflict: false,
    projectionVersion: 1,
    projectionStatus: "created",
  };
  const candidate = {
    hotelId: TARGET.hotelId,
    confirmationNumber: TARGET.otaBookingId,
    reservationId: TARGET.reservationMongoId,
    pmsConfirmationNumber: TARGET.pmsConfirmationNumber,
    matchedLookupValue: TARGET.otaBookingId,
    actionPreview: "matched_existing_no_write",
    checkinDate: TARGET.checkinDate,
    checkoutDate: TARGET.checkoutDate,
    sourceCurrency: "USD",
    sourceAmount: TARGET.portalGuestGross,
    amount: null,
    currency: "USD",
    propertyCurrency: "SAR",
    propertyConversionVerified: false,
    exchangeRateToSar: 3.75,
    exchangeRateSource: "fallback_default",
    paymentCollectionModel: "expedia_collect",
    detailsFetched: true,
    paymentSummary: {
      sourceCurrency: "USD",
      sourceTotalGuestPaymentAmount: TARGET.portalGuestGross,
      sourceNightlyRateAmount: null,
      sourceTaxesAmount: null,
      sourceExpediaCompensationAmount: null,
      sourceAcceleratorAmount: null,
      sourceTotalPayoutAmount: TARGET.hotelRunnerReportedAmount,
      totalGuestPaymentAmount: null,
      totalPayoutAmount: null,
      currency: null,
      propertyCurrency: "SAR",
      propertyConversionVerified: false,
      exchangeRateToSar: 3.75,
      exchangeRateSource: "fallback_default",
    },
  };
  const job = {
    _id: oid(v1.DEFAULT_PORTAL_SELECTION.jobId),
    __v: 0,
    jobNumber: v1.DEFAULT_PORTAL_SELECTION.jobNumber,
    status: "preview_ready",
    provider: "expedia",
    operation: "reservation_sync_preview",
    executionMode: "supervised_read_only",
    createdBy: OWNER_ID,
    dateFrom: TARGET.portalDateFrom,
    dateTo: TARGET.portalDateTo,
    timezone: "Asia/Riyadh",
    hotelCount: 1,
    targetHotels: [{ hotelId: TARGET.hotelId, hotelName: "Zad Ajyad" }],
    previewBuckets: {
      newReservations: [],
      skippedCancelled: [],
      matchedExisting: [candidate],
      statusChanged: [],
      conflicts: [],
      needsReview: [],
      paymentOrVccAvailable: [],
    },
    collectorState: {
      status: "preview_ready",
      readOnly: true,
      selectedHotelIds: [TARGET.hotelId],
      selectedHotelCount: 1,
      finishedAt: new Date("2026-08-09T03:40:00.000Z"),
    },
    resultSummary: { matchedExisting: 1, appliedWrites: 0 },
    auditLog: [
      {
        at: new Date("2026-08-09T03:40:00.000Z"),
        action: "collector_finished",
        readOnly: true,
      },
    ],
    createdAt: new Date("2026-08-09T03:38:15.000Z"),
    updatedAt: new Date("2026-08-09T03:40:00.000Z"),
  };
  return { reservation, event, mirror, job };
}

function v2Job({ createdAt, rate = 3.75 } = {}) {
  const created = new Date(createdAt);
  const convertedAt = new Date(created.getTime() + 30_000);
  const finishedAt = new Date(created.getTime() + 60_000);
  const sourceTimestamp = new Date(created.getTime() - 6 * 60 * 60_000);
  const normalizedRate = Number(Number(rate).toFixed(10));
  const sourceHash = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        provider: "exchange_rate_api",
        sourceType: "trusted_exchange_evidence",
        sourceCurrency: "USD",
        propertyCurrency: "SAR",
        rate: normalizedRate,
        sourceTimestamp: sourceTimestamp.toISOString(),
      })
    )
    .digest("hex");
  const gross = round2(TARGET.portalGuestGross * rate);
  const payout = round2(TARGET.hotelRunnerReportedAmount * rate);
  const conversion = {
    trusted: true,
    verified: true,
    sourceCurrency: "USD",
    propertyCurrency: "SAR",
    rate: normalizedRate,
    provenance: {
      provider: "exchange_rate_api",
      sourceType: "trusted_exchange_evidence",
      sourceHash,
      sourceTimestamp: sourceTimestamp.toISOString(),
      sourceId: "exchange-rate-api-usd-sar-" + sourceHash.slice(0, 24),
    },
  };
  const producerCapturedAt = new Date(created.getTime() - 6 * 60 * 60_000);
  const producerAttestation = {
    schemaVersion: 1,
    source: "git",
    releaseSha: RELEASE_SHA,
    treeSha: TREE_SHA,
    trackedWorktreeClean: true,
    evidenceEligible: true,
    status: "verified_clean",
    capturedAt: producerCapturedAt.toISOString(),
  };
  const candidate = {
    hotelId: TARGET.hotelId,
    confirmationNumber: TARGET.otaBookingId,
    reservationId: TARGET.reservationMongoId,
    pmsConfirmationNumber: TARGET.pmsConfirmationNumber,
    matchedLookupValue: TARGET.otaBookingId,
    actionPreview: "matched_existing_no_write",
    checkinDate: TARGET.checkinDate,
    checkoutDate: TARGET.checkoutDate,
    sourceCurrency: "USD",
    sourceAmount: TARGET.portalGuestGross,
    sourcePayoutAmount: TARGET.hotelRunnerReportedAmount,
    sourcePayoutCurrency: "USD",
    totalAmountSar: gross,
    totalPayoutSar: payout,
    netAfterExpensesTotal: payout,
    amount: gross,
    currency: "SAR",
    propertyCurrency: "SAR",
    propertyConversionVerified: true,
    exchangeRateToSar: rate,
    exchangeRateSource: "exchange_rate_api",
    amountConvertedAt: convertedAt.toISOString(),
    currencyConversionEvidence: conversion,
    paymentCollectionModel: "expedia_collect",
    detailsFetched: true,
    detailCommercialEvidence: {
      guestGrossExplicit: true,
      hotelPayoutExplicit: true,
      sourceCurrency: "USD",
    },
    commercialEvidenceConflict: false,
    commercialEvidenceConflicts: [],
    sourceSnippet: "PRIVATE SOURCE CONTENT MUST NEVER BE LOGGED",
    paymentSummary: {
      sourceCurrency: "USD",
      sourceNightlyRateAmount: null,
      sourceTaxesAmount: null,
      sourceTotalGuestPaymentAmount: TARGET.portalGuestGross,
      sourceExpediaCompensationAmount: null,
      sourceAcceleratorAmount: null,
      sourceTotalPayoutAmount: TARGET.hotelRunnerReportedAmount,
      sourceTotalPayoutCurrency: "USD",
      nightlyRateAmount: null,
      taxesAmount: null,
      totalGuestPaymentAmount: gross,
      expediaCompensationAmount: null,
      acceleratorAmount: null,
      totalPayoutAmount: payout,
      currency: "SAR",
      propertyCurrency: "SAR",
      propertyConversionVerified: true,
      exchangeRateToSar: rate,
      exchangeRateSource: "exchange_rate_api",
      amountConvertedAt: convertedAt.toISOString(),
    },
  };
  const paymentAuxiliary = {
    hotelId: TARGET.hotelId,
    confirmationNumber: TARGET.otaBookingId,
    reservationId: TARGET.reservationMongoId,
    paymentCollectionModel: "expedia_collect",
    currency: "SAR",
    propertyCurrency: "SAR",
    propertyConversionVerified: true,
    sourceCurrency: "USD",
    sourceAmount: TARGET.portalGuestGross,
    exchangeRateToSar: rate,
    exchangeRateSource: "exchange_rate_api",
    amountConvertedAt: convertedAt.toISOString(),
    currencyConversionEvidence: cloneBson(conversion),
    totalGuestPaymentAmount: gross,
    sourceTotalGuestPaymentAmount: TARGET.portalGuestGross,
    totalPayoutAmount: payout,
    sourceTotalPayoutAmount: TARGET.hotelRunnerReportedAmount,
    sourceTotalPayoutCurrency: "USD",
    hasVirtualCardSignal: false,
    rawCardStored: false,
    actionPreview: "payment_signal_no_card_data_stored",
  };
  return {
    _id: oid(PORTAL_SELECTION.jobId),
    __v: 0,
    jobNumber: PORTAL_SELECTION.jobNumber,
    status: "preview_ready",
    provider: "expedia",
    operation: "reservation_sync_preview",
    executionMode: "supervised_read_only",
    createdBy: OWNER_ID,
    dateFrom: TARGET.portalDateFrom,
    dateTo: TARGET.portalDateTo,
    timezone: "Asia/Riyadh",
    hotelCount: 1,
    targetHotels: [{ hotelId: TARGET.hotelId, hotelName: "Zad Ajyad" }],
    collectorPlan: {
      producerReleaseAttestation: cloneBson(producerAttestation),
    },
    previewBuckets: {
      newReservations: [],
      skippedCancelled: [],
      matchedExisting: [candidate],
      statusChanged: [],
      conflicts: [],
      needsReview: [],
      paymentOrVccAvailable: [paymentAuxiliary],
    },
    collectorState: {
      status: "preview_ready",
      readOnly: true,
      selectedHotelIds: [TARGET.hotelId],
      selectedHotelCount: 1,
      finishedAt,
    },
    resultSummary: { matchedExisting: 1, appliedWrites: 0 },
    auditLog: [
      {
        at: new Date(created.getTime() + 1_000),
        action: "collector_queued",
        readOnly: true,
        producerReleaseAttestation: cloneBson(producerAttestation),
      },
      {
        at: new Date(created.getTime() + 2_000),
        action: "collector_started",
        readOnly: true,
        producerReleaseAttestation: cloneBson(producerAttestation),
      },
      {
        at: finishedAt,
        action: "collector_finished",
        readOnly: true,
        producerReleaseAttestation: cloneBson(producerAttestation),
      },
    ],
    createdAt: created,
    updatedAt: finishedAt,
  };
}

const round2 = (value) => Number(Number(value).toFixed(2));

async function preparedFixture({ rate = 3.75, mutateSourceReservation } = {}) {
  const source = v1Fixture();
  if (typeof mutateSourceReservation === "function") {
    mutateSourceReservation(source.reservation);
  }
  const db = new MemoryDb({
    [COLLECTIONS.reservation]: [source.reservation],
    [COLLECTIONS.event]: [source.event],
    [COLLECTIONS.mirror]: [source.mirror],
    [COLLECTIONS.portalJob]: [source.job],
  });
  const v1Plan = await v1.loadPlan({
    db,
    releaseSha: V1_RELEASE_SHA,
    plannedAt: V1_PLANNED_AT,
    portalSelection: v1.DEFAULT_PORTAL_SELECTION,
  });
  await v1.applyRepairPlan({ db, plan: v1Plan });
  const v1Manifest = await db
    .collection(v1.MANIFEST_COLLECTION)
    .findOne({ _id: v1.REPAIR_ID });
  const createdAt = new Date(new Date(v1Manifest.appliedAt).getTime() + 60_000);
  const job = v2Job({ createdAt, rate });
  db.collection(COLLECTIONS.portalJob).documents.push(cloneBson(job));
  const plannedAt = new Date(
    new Date(job.collectorState.finishedAt).getTime() + 60_000
  );
  return {
    db,
    source,
    job,
    plannedAt,
    v1Plan,
    v1Manifest,
    v1ManifestHash: canonicalEjsonSha256(v1Manifest),
    v1BackupHashes: db
      .collection(v1.BACKUP_COLLECTION)
      .documents.map((record) => record.recordHash),
  };
}

async function readyPlan(fixture) {
  return readyPlanAt(fixture, fixture.plannedAt);
}

async function readyPlanAt(fixture, plannedAt) {
  return loadPlan({
    db: fixture.db,
    releaseSha: RELEASE_SHA,
    plannedAt,
    portalSelection: PORTAL_SELECTION,
    execution: CLEAN_EXECUTION,
  });
}

const baseArgs = () => [
  "--release-sha=" + RELEASE_SHA,
  "--portal-job-id=" + PORTAL_SELECTION.jobId,
  "--portal-job-number=" + PORTAL_SELECTION.jobNumber,
];

const cleanExecutionAttestor = () => cloneBson(CLEAN_EXECUTION);

async function applyPlanThroughMain(
  fixture,
  plan,
  {
    now = new Date(plan.proofIssuedAt.getTime() + 1_000),
    clock,
    executionAttestor,
  } = {}
) {
  const appliedClock = clock || (() => now);
  const originalLog = console.log;
  console.log = () => {};
  try {
    return await main(
      [
        "--apply",
        "--repair-id=" + REPAIR_ID,
        "--proof=" + proofToken(plan),
        ...baseArgs(),
      ],
      {
        db: fixture.db,
        clock: appliedClock,
        resolveReleaseSha: () => RELEASE_SHA,
        executionAttestor: executionAttestor || cleanExecutionAttestor,
      }
    );
  } finally {
    console.log = originalLog;
  }
}

async function rollbackPlanThroughMain(
  fixture,
  plan,
  { now = new Date(plan.proofIssuedAt.getTime() + 1_000), clock } = {}
) {
  const originalLog = console.log;
  console.log = () => {};
  try {
    return await main(
      [
        "--rollback",
        "--apply",
        "--repair-id=" + REPAIR_ID,
        "--proof=" + proofToken(plan),
        ...baseArgs(),
      ],
      {
        db: fixture.db,
        clock: clock || (() => now),
        resolveReleaseSha: () => RELEASE_SHA,
        executionAttestor: cleanExecutionAttestor,
      }
    );
  } finally {
    console.log = originalLog;
  }
}

test("production entrypoint exposes no dependency-injectable mutation runner", async () => {
  assert.equal(repairApi.__runMainForTests, undefined);
  assert.equal(repairApi.runMainWithDependencies, undefined);
  await assert.rejects(
    () =>
      productionMain(baseArgs(), {
        db: new MemoryDb(),
        clock: () => new Date(0),
        resolveReleaseSha: () => RELEASE_SHA,
        executionAttestor: cleanExecutionAttestor,
      }),
    /injected dependencies/i
  );
});

test("v2 CLI requires explicit fresh evidence selectors and exact proof fencing", () => {
  assert.throws(
    () => parseArguments(["--release-sha=" + RELEASE_SHA]),
    /fresh portal evidence/
  );
  const dryRun = parseArguments([
    "--release-sha=" + RELEASE_SHA,
    "--portal-job-id=" + PORTAL_SELECTION.jobId,
    "--portal-job-number=" + PORTAL_SELECTION.jobNumber,
  ]);
  assert.equal(dryRun.apply, false);
  assert.equal(dryRun.portalJobId, PORTAL_SELECTION.jobId);
  assert.throws(
    () =>
      parseArguments([
        "--apply",
        "--repair-id=" + REPAIR_ID,
        "--release-sha=" + RELEASE_SHA,
        "--portal-job-id=" + PORTAL_SELECTION.jobId,
        "--portal-job-number=" + PORTAL_SELECTION.jobNumber,
      ]),
    /dry-run proof/
  );
});

test("v2 has no vendor client, HTTP, fetch, or reservation-create execution path", () => {
  const source = fs.readFileSync(
    path.resolve(
      __dirname,
      "repairExpediaCommercialMaterialization20260809.js"
    ),
    "utf8"
  );
  assert.doesNotMatch(
    source,
    /require\([^\n]*(hotelrunnerClient|expediaReservationCollector|node:https|node:http|axios)/
  );
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(
    source,
    /Reservations\.(create|insertMany)|new\s+Reservations\b/
  );
});

test("dry run dynamically materializes 3.75 evidence and cent-exact weighted nights", async () => {
  const fixture = await preparedFixture();
  const plan = await readyPlan(fixture);
  assert.equal(plan.state, "ready");
  assert.equal(fixture.db.collection(BACKUP_COLLECTION).documents.length, 0);
  assert.equal(
    fixture.db
      .collection(MANIFEST_COLLECTION)
      .documents.filter((entry) => entry._id === REPAIR_ID).length,
    0
  );
  assert.equal(plan.commercial.conversion.rate, 3.75);
  assert.equal(plan.commercial.gross, 549.23);
  assert.equal(plan.commercial.payout, 423.45);
  assert.equal(plan.commercial.deduction, 125.78);
  assert.equal(plan.commercial.margin, -110.55);
  const expected = plan.expectedDocument;
  assert.equal(expected.__v, 3);
  assert.equal(expected.total_amount, 549.23);
  assert.equal(expected.commission, 0);
  assert.equal(expected.commission_ota, null);
  assert.equal(expected.adminPricing.clientTotal, 549.23);
  assert.equal(expected.adminPricing.netAfterExpensesTotal, 423.45);
  assert.equal(expected.adminPricing.otaExpenseTotal, 125.78);
  assert.equal(expected.adminPricing.platformMarginTotal, -110.55);
  assert.equal(expected.supplierData.otaAmount, 146.46);
  assert.equal(expected.supplierData.otaSourceAmount, 146.46);
  assert.equal(expected.supplierData.otaTotalPayoutSar, 423.45);
  assert.equal(expected.supplierData.otaCommissionSar, null);
  assert.equal(
    expected.supplierData.otaCommercialRepair.repairId,
    v1.REPAIR_ID
  );
  assert.equal(
    expected.supplierData.otaCommercialMaterializationRepair.repairId,
    REPAIR_ID
  );
  const days = expected.pickedRoomsPricing[0].pricingByDay;
  assert.deepEqual(
    days.map((day) => day.clientPrice),
    [91.54, 91.54, 91.54, 91.54, 91.54, 91.53]
  );
  assert.deepEqual(
    days.map((day) => day.netAfterExpenses),
    [70.58, 70.58, 70.58, 70.57, 70.57, 70.57]
  );
  assert.equal(
    round2(days.reduce((sum, day) => sum + day.otaExpenseAmount, 0)),
    125.78
  );
  assert.equal(
    round2(days.reduce((sum, day) => sum + day.platformMargin, 0)),
    -110.55
  );
  assert.deepEqual(allocateCentsByWeight(10, [1, 2, 3]), [1.67, 3.33, 5]);
  const repeat = await readyPlan(fixture);
  assert.equal(repeat.planHash, plan.planHash);
  assert.equal(proofToken(repeat), proofToken(plan));
});

test("the trusted rate is dynamic rather than hard-coded to 3.75", async () => {
  const fixture = await preparedFixture({ rate: 4 });
  const plan = await readyPlan(fixture);
  assert.equal(plan.commercial.gross, 585.84);
  assert.equal(plan.commercial.payout, 451.68);
  assert.equal(plan.commercial.deduction, 134.16);
  assert.equal(plan.commercial.margin, -82.32);
  assert.equal(plan.expectedDocument.total_amount, 585.84);
  assert.equal(plan.expectedDocument.supplierData.otaExchangeRateToSar, 4);
});

test("signed Expedia deductions retain their source signs and trusted conversion", async () => {
  const fixture = await preparedFixture();
  const candidate = fixture.db.collection(COLLECTIONS.portalJob).documents[1]
    .previewBuckets.matchedExisting[0];
  Object.assign(candidate.paymentSummary, {
    sourceNightlyRateAmount: null,
    sourceTaxesAmount: 22.26,
    sourceExpediaCompensationAmount: -22.38,
    sourceAcceleratorAmount: -11.16,
    nightlyRateAmount: null,
    taxesAmount: null,
    expediaCompensationAmount: null,
    acceleratorAmount: null,
  });

  const plan = await readyPlan(fixture);
  const paymentSummary =
    plan.expectedDocument.supplierData.otaPaymentSummary;
  assert.equal(paymentSummary.sourceNightlyRateAmount, null);
  assert.equal(paymentSummary.sourceTaxesAmount, 22.26);
  assert.equal(paymentSummary.sourceExpediaCompensationAmount, -22.38);
  assert.equal(paymentSummary.sourceAcceleratorAmount, -11.16);
  assert.equal(paymentSummary.nightlyRateAmount, null);
  assert.equal(paymentSummary.taxesAmount, 83.48);
  assert.equal(paymentSummary.expediaCompensationAmount, -83.92);
  assert.equal(paymentSummary.acceleratorAmount, -41.85);
  assert.deepEqual(
    paymentSummary.currencyConversionEvidence,
    candidate.currencyConversionEvidence
  );
  assert.deepEqual(
    plan.expectedDocument.ota_financial_summary.paymentSummary,
    paymentSummary
  );
});

test("signed deductions do not relax malformed, nightly, or tax money", async () => {
  const unsafeValues = [
    ["sourceNightlyRateAmount", -0.01],
    ["sourceTaxesAmount", -0.01],
    ["sourceExpediaCompensationAmount", "not-money"],
    ["sourceAcceleratorAmount", "Infinity"],
  ];
  for (const [field, value] of unsafeValues) {
    const fixture = await preparedFixture();
    fixture.db.collection(COLLECTIONS.portalJob).documents[1].previewBuckets
      .matchedExisting[0].paymentSummary[field] = value;
    await assert.rejects(
      () => readyPlan(fixture),
      (error) => error?.code === "EXPEDIA_V2_PORTAL_MONEY_INVALID"
    );
  }
});

test("apply creates a separate immutable backup and preserves all v1 artifacts", async () => {
  const fixture = await preparedFixture();
  const plan = await readyPlan(fixture);
  const evidenceHashesBefore = {
    event: canonicalEjsonSha256(
      fixture.db.collection(COLLECTIONS.event).documents[0]
    ),
    mirror: canonicalEjsonSha256(
      fixture.db.collection(COLLECTIONS.mirror).documents[0]
    ),
    portal: canonicalEjsonSha256(
      fixture.db.collection(COLLECTIONS.portalJob).documents[1]
    ),
  };
  const v1ManifestBefore = cloneBson(
    await fixture.db
      .collection(v1.MANIFEST_COLLECTION)
      .findOne({ _id: v1.REPAIR_ID })
  );
  const v1BackupsBefore = cloneBson(
    fixture.db.collection(v1.BACKUP_COLLECTION).documents
  );
  const protectedCollections = [
    fixture.db.collection(COLLECTIONS.event),
    fixture.db.collection(COLLECTIONS.mirror),
    fixture.db.collection(COLLECTIONS.portalJob),
    fixture.db.collection(v1.BACKUP_COLLECTION),
    fixture.db.collection(BACKUP_COLLECTION),
  ];
  const protectedReplaceCounts = protectedCollections.map(
    (collection) => collection.replaceCalls
  );
  const manifestReplacementIds = [];
  const manifestsCollection = fixture.db.collection(MANIFEST_COLLECTION);
  manifestsCollection.beforeReplace = ({ replacement }) => {
    manifestReplacementIds.push(String(replacement._id));
  };
  const result = await applyPlanThroughMain(fixture, plan);
  manifestsCollection.beforeReplace = null;
  assert.equal(result.state, "applied");
  assert.equal(result.changed, 1);
  assert.equal(
    fixture.db.collection(COLLECTIONS.reservation).replaceCalls,
    2,
    "one v1 CAS plus one v2 CAS"
  );
  const repaired = await fixture.db
    .collection(COLLECTIONS.reservation)
    .findOne({ _id: oid(TARGET.reservationMongoId) });
  assert.equal(canonicalEjsonSha256(repaired), plan.expectedHash);
  assert.equal(repaired.payment_details.captured, false);
  assert.equal(repaired.bofa_payment.vcc.secretSentinel, "must-survive");
  assert.equal(
    repaired.supplierData.hotelRunner.immutableRawSentinel.untouched,
    true
  );
  assert.equal(fixture.db.collection(BACKUP_COLLECTION).documents.length, 4);
  const manifest = await fixture.db
    .collection(MANIFEST_COLLECTION)
    .findOne({ _id: REPAIR_ID });
  assert.equal(manifest.state, "applied");
  assert.equal(manifest.appliedDocumentHash, plan.expectedHash);
  assert.equal(manifest.predecessorManifestHash, fixture.v1ManifestHash);
  assert.equal(manifest.backupRecordCount, 4);
  assert.deepEqual(Object.keys(manifest.backupRecordHashes).sort(), [
    "expedia_portal_job_evidence",
    "hotelrunner_event_evidence",
    "hotelrunner_mirror_evidence",
    "reservation_before",
  ]);
  const verifiedBackup = verifyBackupRecords(
    fixture.db.collection(BACKUP_COLLECTION).documents,
    manifest
  );
  assert.equal(verifiedBackup.backupSetSha256, manifest.backupSetSha256);
  assert.equal(
    canonicalEjsonSha256(fixture.db.collection(COLLECTIONS.event).documents[0]),
    evidenceHashesBefore.event
  );
  assert.equal(
    canonicalEjsonSha256(
      fixture.db.collection(COLLECTIONS.mirror).documents[0]
    ),
    evidenceHashesBefore.mirror
  );
  assert.equal(
    canonicalEjsonSha256(
      fixture.db.collection(COLLECTIONS.portalJob).documents[1]
    ),
    evidenceHashesBefore.portal
  );
  assert.equal(
    canonicalEjsonSha256(
      await fixture.db
        .collection(v1.MANIFEST_COLLECTION)
        .findOne({ _id: v1.REPAIR_ID })
    ),
    canonicalEjsonSha256(v1ManifestBefore)
  );
  assert.equal(
    canonicalEjsonSha256(fixture.db.collection(v1.BACKUP_COLLECTION).documents),
    canonicalEjsonSha256(v1BackupsBefore)
  );
  assert.deepEqual(
    protectedCollections.map((collection) => collection.replaceCalls),
    protectedReplaceCounts,
    "protected live evidence and v1/v2 backups receive zero replacements"
  );
  assert.equal(
    manifestReplacementIds.every((id) => id === REPAIR_ID),
    true,
    "the shared manifest collection never replaces the v1 manifest"
  );
});

test("a long-delayed applied rerun revalidates and remains zero-write", async () => {
  const fixture = await preparedFixture();
  const plan = await readyPlan(fixture);
  await applyPlanThroughMain(fixture, plan);
  const replaceCalls = fixture.db.collection(
    COLLECTIONS.reservation
  ).replaceCalls;
  const delayedAt = new Date(plan.proofIssuedAt.getTime() + 25 * 60 * 60_000);
  const portalJobs = fixture.db.collection(COLLECTIONS.portalJob);
  portalJobs.beforeFindOne = () => {
    portalJobs.beforeFindOne = null;
    throw new Error("transient terminal verification read");
  };
  await assert.rejects(
    () => readyPlanAt(fixture, delayedAt),
    /transient terminal verification read/
  );
  assert.equal(
    (
      await fixture.db
        .collection(MANIFEST_COLLECTION)
        .findOne({ _id: REPAIR_ID })
    ).state,
    "applied"
  );
  const rerun = await readyPlanAt(
    fixture,
    new Date(delayedAt.getTime() + 60_000)
  );
  assert.equal(rerun.state, "already_applied");
  const result = await applyPlanThroughMain(fixture, rerun);
  assert.equal(result.state, "already_applied");
  assert.equal(result.changed, 0);
  assert.equal(
    fixture.db.collection(COLLECTIONS.reservation).replaceCalls,
    replaceCalls
  );
});

test("full-document CAS blocks any post-plan reservation change", async () => {
  const fixture = await preparedFixture();
  const plan = await readyPlan(fixture);
  const live = fixture.db.collection(COLLECTIONS.reservation).documents[0];
  live.internalConcurrentSentinel = "changed-after-plan";
  await assert.rejects(
    () => applyPlanThroughMain(fixture, plan),
    /exact immutable v1|reservation changed after/
  );
  assert.equal(
    fixture.db.collection(COLLECTIONS.reservation).replaceCalls,
    1,
    "only the earlier v1 replacement ran"
  );
  assert.equal(
    fixture.db.collection(COLLECTIONS.reservation).documents[0]
      .internalConcurrentSentinel,
    "changed-after-plan"
  );
});

const applyProductionProtectedBaseline = (reservation) => {
  reservation.paid_amount = 423.45;
  reservation.financeStatus = "paid online";
  reservation.payment = "paid online";
  reservation.housedBy = { name: "" };
  reservation.paid_amount_breakdown = {
    paid_online_via_link: 0,
    paid_at_hotel_cash: 0,
    paid_at_hotel_card: 0,
    paid_to_hotel: 0,
    paid_online_jannatbooking: 0,
    paid_online_other_platforms: 423.45,
    paid_online_via_instapay: 0,
    paid_no_show: 0,
    payment_comments: "Expedia collected by platform",
  };
  reservation.financial_cycle = {
    collectionModel: "pms_collected",
    status: "open",
    commissionType: "amount",
    commissionValue: 0,
    commissionAmount: 0,
    commissionAssigned: false,
    pmsCollectedAmount: 423.45,
    hotelCollectedAmount: 0,
    hotelPayoutDue: 534,
    commissionDueToPms: 0,
    lastUpdatedAt: new Date("2026-08-09T03:11:26.196Z"),
  };
  reservation.payment_details = {
    captured: false,
    onsite_paid_amount: 0,
  };
};

test("the exact paid-online and legacy housedBy baseline is safe and preserved", async () => {
  const fixture = await preparedFixture({
    mutateSourceReservation: applyProductionProtectedBaseline,
  });
  const plan = await readyPlan(fixture);
  assert.equal(plan.state, "ready");
  const result = await applyPlanThroughMain(fixture, plan);
  assert.equal(result.state, "applied");
  const repaired = await fixture.db
    .collection(COLLECTIONS.reservation)
    .findOne({ _id: oid(TARGET.reservationMongoId) });
  assert.equal(repaired.paid_amount, 423.45);
  assert.equal(repaired.financeStatus, "paid online");
  assert.equal(repaired.payment, "paid online");
  assert.deepEqual(repaired.housedBy, { name: "" });
  assert.deepEqual(repaired.paid_amount_breakdown, {
    paid_online_via_link: 0,
    paid_at_hotel_cash: 0,
    paid_at_hotel_card: 0,
    paid_to_hotel: 0,
    paid_online_jannatbooking: 0,
    paid_online_other_platforms: 423.45,
    paid_online_via_instapay: 0,
    paid_no_show: 0,
    payment_comments: "Expedia collected by platform",
  });
  assert.deepEqual(repaired.financial_cycle, {
    collectionModel: "pms_collected",
    status: "open",
    commissionType: "amount",
    commissionValue: 0,
    commissionAmount: 0,
    commissionAssigned: false,
    pmsCollectedAmount: 423.45,
    hotelCollectedAmount: 0,
    hotelPayoutDue: 534,
    commissionDueToPms: 0,
    lastUpdatedAt: new Date("2026-08-09T03:11:26.196Z"),
  });
  assert.deepEqual(repaired.payment_details, {
    captured: false,
    onsite_paid_amount: 0,
  });
});

test("paid_amount, financeStatus, or housedBy baseline drift remains blocked", async () => {
  const mutations = [
    (reservation) => {
      reservation.paid_amount = 424.45;
    },
    (reservation) => {
      reservation.financeStatus = "paid";
    },
    (reservation) => {
      reservation.financeStatus = "Paid Online";
    },
    (reservation) => {
      reservation.housedBy.name = "changed";
    },
  ];
  for (const mutate of mutations) {
    const fixture = await preparedFixture({
      mutateSourceReservation: applyProductionProtectedBaseline,
    });
    mutate(fixture.db.collection(COLLECTIONS.reservation).documents[0]);
    await assert.rejects(
      () => readyPlan(fixture),
      (error) => error?.code === "EXPEDIA_V2_PROTECTED_STATE"
    );
  }
});

test("unsafe expected baselines and canonical capture signals remain blocked", async () => {
  const unsafeBaselines = [
    (reservation) => {
      reservation.paid_amount = 999;
    },
    (reservation) => {
      reservation.paid_amount = "423.45";
    },
    (reservation) => {
      reservation.financeStatus = "paid";
    },
    (reservation) => {
      reservation.financeStatus = "Paid Online";
    },
    (reservation) => {
      reservation.housedBy = { name: "arbitrary" };
    },
    (reservation) => {
      reservation.housedBy = new Date(Number.NaN);
    },
    (reservation) => {
      reservation.housedBy = oid("6a40df5f1a6d1850eb25c184");
    },
    (reservation) => {
      reservation.inhouse_date = new Date("2026-08-09T05:00:00.000Z");
    },
    (reservation) => {
      reservation.housedAt = new Date("2026-08-09T05:00:00.000Z");
    },
    (reservation) => {
      reservation.checkedInAt = new Date("2026-08-09T05:00:00.000Z");
    },
    (reservation) => {
      reservation.checkedOutAt = new Date("2026-08-09T05:00:00.000Z");
    },
    (reservation) => {
      reservation.vcc_payment = { charged: true };
    },
    (reservation) => {
      reservation.financial_cycle = {
        status: "closed",
        closedAt: new Date("2026-08-09T05:00:00.000Z"),
      };
    },
    (reservation) => {
      reservation.commissionPaidAt = new Date("2026-08-09T05:00:00.000Z");
    },
    (reservation) => {
      reservation.moneyTransferredAt = new Date("2026-08-09T05:00:00.000Z");
    },
    (reservation) => {
      reservation.paid_amount_breakdown.paid_at_hotel_cash = 1;
    },
    (reservation) => {
      reservation.braintree_payment = { captured: true };
    },
    (reservation) => {
      reservation.bofa_payment.secure_acceptance = { status: "approved" };
    },
    (reservation) => {
      reservation.vcc_payment = { last_transaction_id: "txn-evidence" };
    },
    (reservation) => {
      reservation.payment_details.finalCaptureTransactionId =
        "capture-evidence";
    },
    (reservation) => {
      reservation.payment_details.captureId = new Date(
        "2026-08-09T05:00:00.000Z"
      );
    },
    (reservation) => {
      reservation.financial_cycle.capturedAt = new Date(
        "2026-08-09T05:00:00.000Z"
      );
    },
    (reservation) => {
      reservation.bofa_payment.vcc.chargedAt = new Date(
        "2026-08-09T05:00:00.000Z"
      );
    },
  ];
  for (const [index, addUnsafeBaseline] of unsafeBaselines.entries()) {
    const fixture = await preparedFixture({
      mutateSourceReservation: (reservation) => {
        applyProductionProtectedBaseline(reservation);
        addUnsafeBaseline(reservation);
      },
    });
    await assert.rejects(
      () => readyPlan(fixture),
      (error) => error?.code === "EXPEDIA_V2_PROTECTED_STATE",
      "unsafe baseline case " + index
    );
  }
});

test("lifecycle, manual, settled, and housed states independently block planning", async () => {
  const mutations = [
    (reservation) => {
      reservation.reservation_status = "cancelled";
    },
    (reservation) => {
      reservation.adminChangeLog = [{ action: "manual pricing" }];
    },
    (reservation) => {
      reservation.paid_amount = 10;
    },
    (reservation) => {
      reservation.payment_details.captured = true;
    },
    (reservation) => {
      reservation.moneyTransferredToHotel = true;
    },
    (reservation) => {
      reservation.financial_cycle = {
        status: "settled",
        settledAt: new Date(),
      };
    },
    (reservation) => {
      reservation.housed = true;
    },
    (reservation) => {
      reservation.checkedInAt = new Date();
    },
    (reservation) => {
      reservation.roomId = [oid("6a40df5f1a6d1850eb25c183")];
    },
  ];
  for (const mutate of mutations) {
    const fixture = await preparedFixture();
    mutate(fixture.db.collection(COLLECTIONS.reservation).documents[0]);
    await assert.rejects(() => readyPlan(fixture));
    assert.equal(
      fixture.db.collection(COLLECTIONS.reservation).replaceCalls,
      1,
      "no v2 replacement is attempted"
    );
  }
});

test("tampered conversion evidence and stale collector evidence fail closed", async () => {
  {
    const fixture = await preparedFixture();
    const candidate = fixture.db.collection(COLLECTIONS.portalJob).documents[1]
      .previewBuckets.matchedExisting[0];
    candidate.currencyConversionEvidence.provenance.sourceHash = "f".repeat(64);
    await assert.rejects(() => readyPlan(fixture), /trusted exact contract/);
  }
  {
    const fixture = await preparedFixture();
    const candidate = fixture.db.collection(COLLECTIONS.portalJob).documents[1]
      .previewBuckets.matchedExisting[0];
    candidate.currencyConversionEvidence.rate = 3.8;
    await assert.rejects(() => readyPlan(fixture), /trusted exact contract/);
  }
  {
    const fixture = await preparedFixture();
    const job = fixture.db.collection(COLLECTIONS.portalJob).documents[1];
    const old = new Date(
      new Date(fixture.v1Manifest.appliedAt).getTime() - 60_000
    );
    job.createdAt = old;
    await assert.rejects(() => readyPlan(fixture), /not fresh after v1/);
  }
});

test("fresh detail evidence requires both explicit USD gross and payout markers", async () => {
  const mutations = [
    (candidate) => {
      delete candidate.detailCommercialEvidence;
    },
    (candidate) => {
      candidate.detailCommercialEvidence.guestGrossExplicit = false;
    },
    (candidate) => {
      candidate.detailCommercialEvidence.hotelPayoutExplicit = false;
    },
    (candidate) => {
      candidate.detailCommercialEvidence.sourceCurrency = "SAR";
    },
    (candidate) => {
      delete candidate.commercialEvidenceConflict;
    },
    (candidate) => {
      candidate.commercialEvidenceConflicts = null;
    },
    (candidate) => {
      candidate.explicitOtaCommission = 0;
    },
    (candidate) => {
      candidate.paymentSummary.explicitOtaCommission = 0;
    },
  ];
  for (const mutate of mutations) {
    const fixture = await preparedFixture();
    mutate(
      fixture.db.collection(COLLECTIONS.portalJob).documents[1].previewBuckets
        .matchedExisting[0]
    );
    await assert.rejects(
      () => readyPlan(fixture),
      /portal row|reconcile|explicit OTA commission/
    );
  }
});

test("trusted conversion evidence rejects extra keys and accessors", () => {
  const job = v2Job({ createdAt: new Date("2026-08-09T05:00:00.000Z") });
  const conversion =
    job.previewBuckets.matchedExisting[0].currencyConversionEvidence;
  conversion.credential = "must-not-be-backed-up";
  assert.throws(() => assertTrustedConversion(conversion), /unexpected shape/);
  delete conversion.credential;
  Object.defineProperty(conversion.provenance, "apiKey", {
    enumerable: true,
    get() {
      return "must-not-be-read";
    },
  });
  assert.throws(() => assertTrustedConversion(conversion), /unexpected shape/);
});

test("target is unique across primary buckets and auxiliary money must reconcile", async () => {
  {
    const fixture = await preparedFixture();
    const buckets = fixture.db.collection(COLLECTIONS.portalJob).documents[1]
      .previewBuckets;
    buckets.conflicts.push(cloneBson(buckets.matchedExisting[0]));
    await assert.rejects(() => readyPlan(fixture), /exactly once/);
  }
  {
    const fixture = await preparedFixture();
    const buckets = fixture.db.collection(COLLECTIONS.portalJob).documents[1]
      .previewBuckets;
    buckets.newReservations.push(buckets.matchedExisting.pop());
    await assert.rejects(() => readyPlan(fixture), /matched-existing/);
  }
  {
    const fixture = await preparedFixture();
    fixture.db.collection(
      COLLECTIONS.portalJob
    ).documents[1].previewBuckets.paymentOrVccAvailable = [];
    await assert.rejects(() => readyPlan(fixture), /exactly once/);
  }
  {
    const fixture = await preparedFixture();
    fixture.db.collection(
      COLLECTIONS.portalJob
    ).documents[1].previewBuckets.paymentOrVccAvailable[0].sourceTotalPayoutAmount = 1;
    await assert.rejects(() => readyPlan(fixture), /auxiliary payment row/);
  }
  {
    const fixture = await preparedFixture();
    fixture.db
      .collection(COLLECTIONS.portalJob)
      .documents[1].previewBuckets.conflicts.push({
        diagnostic: TARGET.otaBookingId,
      });
    assert.equal((await readyPlan(fixture)).state, "ready");
  }
});

test("global PMS and every provider alias reject wrong-hotel duplicates", async () => {
  {
    const fixture = await preparedFixture();
    const duplicate = cloneBson(
      fixture.db.collection(COLLECTIONS.reservation).documents[0]
    );
    duplicate._id = oid("6a77efde7735a50431e27127");
    duplicate.hotelId = oid("6a40b6a1a6efe70450536039");
    duplicate.reservation_id = "unrelated";
    duplicate.otaIdentityKey = "expedia:unrelated";
    duplicate.customer_details.confirmation_number2 = "unrelated";
    duplicate.supplierData.otaConfirmationNumber = "unrelated";
    duplicate.supplierData.platformConfirmationNumber = "unrelated";
    duplicate.supplierData.suppliedBookingNo = "unrelated";
    duplicate.supplierData.hotelRunner.providerNumber = "unrelated";
    fixture.db.collection(COLLECTIONS.reservation).documents.push(duplicate);
    await assert.rejects(() => readyPlan(fixture), /uniqueness boundary/);
  }
  {
    const fixture = await preparedFixture();
    const duplicate = cloneBson(
      fixture.db.collection(COLLECTIONS.reservation).documents[0]
    );
    duplicate._id = oid("6a77efde7735a50431e27128");
    duplicate.hotelId = oid("6a40b6a1a6efe70450536039");
    duplicate.confirmation_number = "unrelated";
    duplicate.reservation_id = "unrelated";
    duplicate.otaIdentityKey = "";
    duplicate.customer_details.confirmation_number2 = "unrelated";
    duplicate.supplierData.otaConfirmationNumber = "unrelated";
    duplicate.supplierData.platformConfirmationNumber = TARGET.otaBookingId;
    duplicate.supplierData.suppliedBookingNo = "unrelated";
    duplicate.supplierData.hotelRunner.providerNumber = "unrelated";
    fixture.db.collection(COLLECTIONS.reservation).documents.push(duplicate);
    await assert.rejects(() => readyPlan(fixture), /uniqueness boundary/);
  }
  {
    const fixture = await preparedFixture();
    const duplicate = cloneBson(
      fixture.db.collection(COLLECTIONS.reservation).documents[0]
    );
    duplicate._id = oid("6a77efde7735a50431e27129");
    duplicate.hotelId = oid("6a40b6a1a6efe70450536039");
    duplicate.confirmation_number = "unrelated";
    duplicate.reservation_id = "unrelated";
    duplicate.otaIdentityKey = "";
    duplicate.otaCrossTransportIdentityKey = "";
    duplicate.customer_details.confirmation_number2 = "unrelated";
    duplicate.supplierData.otaConfirmationNumber = "unrelated";
    duplicate.supplierData.platformConfirmationNumber = "unrelated";
    duplicate.supplierData.suppliedBookingNo = TARGET.otaBookingId;
    duplicate.supplierData.hotelRunner.providerNumber = "unrelated";
    fixture.db.collection(COLLECTIONS.reservation).documents.push(duplicate);
    await assert.rejects(() => readyPlan(fixture), /uniqueness boundary/);
  }
});

test("collector producer release attestation is exact and supports module-start capture", async () => {
  {
    const fixture = await preparedFixture();
    const job = fixture.db.collection(COLLECTIONS.portalJob).documents[1];
    const capturedAt = new Date(
      new Date(job.createdAt).getTime() - 7 * 24 * 60 * 60_000
    );
    job.collectorPlan.producerReleaseAttestation.capturedAt =
      capturedAt.toISOString();
    for (const [index, action] of [
      "collector_queued",
      "collector_started",
      "collector_finished",
    ].entries()) {
      const entry = job.auditLog.find((item) => item.action === action);
      entry.producerReleaseAttestation = cloneBson(
        job.collectorPlan.producerReleaseAttestation
      );
      entry.at = new Date(
        new Date(job.createdAt).getTime() +
          (action === "collector_finished" ? 60_000 : (index + 1) * 1_000)
      );
    }
    job.collectorState.finishedAt = new Date(
      new Date(job.createdAt).getTime() + 60_000
    );
    job.updatedAt = cloneBson(job.collectorState.finishedAt);
    const issuedAt = new Date(job.collectorState.finishedAt.getTime() + 60_000);
    assert.equal((await readyPlanAt(fixture, issuedAt)).state, "ready");
  }
  for (const mutate of [
    (attestation) => {
      attestation.evidenceEligible = false;
      attestation.status = "tracked_worktree_dirty";
    },
    (attestation) => {
      attestation.releaseSha = "f".repeat(40);
    },
    (attestation) => {
      attestation.apiKey = "poison";
    },
  ]) {
    const fixture = await preparedFixture();
    mutate(
      fixture.db.collection(COLLECTIONS.portalJob).documents[1].collectorPlan
        .producerReleaseAttestation
    );
    await assert.rejects(
      () => readyPlan(fixture),
      /exact approved clean release/
    );
  }
  {
    const fixture = await preparedFixture();
    const job = fixture.db.collection(COLLECTIONS.portalJob).documents[1];
    job.auditLog.find(
      (entry) => entry.action === "collector_started"
    ).producerReleaseAttestation.treeSha = "f".repeat(40);
    await assert.rejects(() => readyPlan(fixture), /does not preserve/);
  }
  for (const mutate of [
    (attestation) => {
      attestation.schemaVersion = "1";
    },
    (attestation) => {
      attestation.source = " git ";
    },
    (attestation) => {
      attestation.releaseSha = attestation.releaseSha.toUpperCase();
    },
  ]) {
    const fixture = await preparedFixture();
    const job = fixture.db.collection(COLLECTIONS.portalJob).documents[1];
    mutate(job.collectorPlan.producerReleaseAttestation);
    for (const entry of job.auditLog) {
      if (entry.producerReleaseAttestation) {
        entry.producerReleaseAttestation = cloneBson(
          job.collectorPlan.producerReleaseAttestation
        );
      }
    }
    await assert.rejects(
      () => readyPlan(fixture),
      /exact approved clean release/
    );
  }
  {
    const fixture = await preparedFixture();
    const job = fixture.db.collection(COLLECTIONS.portalJob).documents[1];
    job.auditLog.find(
      (entry) => entry.action === "collector_started"
    ).readOnly = false;
    await assert.rejects(() => readyPlan(fixture), /does not preserve/);
  }
});

test("missing zero-write and zero-vendor proof fields fail closed", async () => {
  for (const value of [undefined, null]) {
    const fixture = await preparedFixture();
    const summary = fixture.db.collection(COLLECTIONS.portalJob).documents[1]
      .resultSummary;
    if (value === undefined) delete summary.appliedWrites;
    else summary.appliedWrites = value;
    await assert.rejects(() => readyPlan(fixture), /job boundary/);
  }
  for (const value of [undefined, null]) {
    const fixture = await preparedFixture();
    const manifest = fixture.db
      .collection(v1.MANIFEST_COLLECTION)
      .documents.find((entry) => entry._id === v1.REPAIR_ID);
    if (value === undefined) delete manifest.vendorApiCalls;
    else manifest.vendorApiCalls = value;
    await assert.rejects(() => readyPlan(fixture), /immutable v1 repair/);
  }
  for (const value of [undefined, null]) {
    const fixture = await preparedFixture();
    const plan = await readyPlan(fixture);
    await applyPlanThroughMain(fixture, plan);
    const manifest = fixture.db
      .collection(MANIFEST_COLLECTION)
      .documents.find((entry) => entry._id === REPAIR_ID);
    if (value === undefined) delete manifest.vendorApiCalls;
    else manifest.vendorApiCalls = value;
    await assert.rejects(() => readyPlan(fixture), /backup set|manifest/);
  }
});

test("cached/stored FX markers and bounded collector audit skew retain exact provenance", async () => {
  for (const marker of [
    "exchange_rate_api_cached",
    "exchange_rate_api_stored",
  ]) {
    const fixture = await preparedFixture();
    const job = fixture.db.collection(COLLECTIONS.portalJob).documents[1];
    const candidate = job.previewBuckets.matchedExisting[0];
    const auxiliary = job.previewBuckets.paymentOrVccAvailable[0];
    candidate.exchangeRateSource = marker;
    candidate.paymentSummary.exchangeRateSource = marker;
    auxiliary.exchangeRateSource = marker;
    if (marker === "exchange_rate_api_cached") {
      const cachedFetch = new Date(
        new Date(job.createdAt).getTime() - 2 * 60 * 60_000
      ).toISOString();
      candidate.amountConvertedAt = cachedFetch;
      candidate.paymentSummary.amountConvertedAt = cachedFetch;
      auxiliary.amountConvertedAt = cachedFetch;
    }
    job.auditLog.find((entry) => entry.action === "collector_finished").at =
      new Date(new Date(job.collectorState.finishedAt).getTime() + 2);
    const plan = await readyPlan(fixture);
    assert.equal(plan.state, "ready");
    assert.equal(
      plan.commercial.conversion.provenance.sourceType,
      "trusted_exchange_evidence"
    );
  }
});

test("portal evidence tampered after planning is caught before the v2 CAS", async () => {
  const fixture = await preparedFixture();
  const plan = await readyPlan(fixture);
  fixture.db.collection(COLLECTIONS.portalJob).documents[1].sourceTamper = true;
  await assert.rejects(
    () => applyPlanThroughMain(fixture, plan),
    /Immutable v2 evidence changed|scope no longer matches/
  );
  assert.equal(fixture.db.collection(COLLECTIONS.reservation).replaceCalls, 1);
});

test("forward recovery resumes valid states and blocks legacy split commits", async () => {
  {
    const fixture = await preparedFixture();
    const plan = await readyPlan(fixture);
    const backups = fixture.db.collection(BACKUP_COLLECTION);
    let inserts = 0;
    backups.beforeInsert = () => {
      inserts += 1;
      if (inserts === 2) throw new Error("simulated backup crash");
    };
    await assert.rejects(
      () => applyPlanThroughMain(fixture, plan),
      /backup could not be persisted/
    );
    backups.beforeInsert = null;
    const manifest = await fixture.db
      .collection(MANIFEST_COLLECTION)
      .findOne({ _id: REPAIR_ID });
    assert.equal(manifest.state, "backing_up");
    assert.equal(backups.documents.length, 1);
    const resumedAt = new Date(plan.proofIssuedAt.getTime() + 62_000);
    const resumed = await readyPlanAt(fixture, resumedAt);
    assert.equal(resumed.resumeState, "backing_up");
    assert.equal(resumed.planHash, plan.planHash);
    assert.equal(
      (await applyPlanThroughMain(fixture, resumed)).state,
      "applied"
    );
  }
  {
    const fixture = await preparedFixture();
    const plan = await readyPlan(fixture);
    const reservations = fixture.db.collection(COLLECTIONS.reservation);
    reservations.beforeReplace = () => {
      throw new Error("simulated pre-reservation crash");
    };
    await assert.rejects(
      () => applyPlanThroughMain(fixture, plan),
      /full-document CAS did not commit/
    );
    reservations.beforeReplace = null;
    assert.equal(
      (
        await fixture.db
          .collection(MANIFEST_COLLECTION)
          .findOne({ _id: REPAIR_ID })
      ).state,
      "backed_up"
    );
    reservations.documents[0] = cloneBson(plan.expectedDocument);
    const reservationWrites = reservations.replaceCalls;
    await assert.rejects(
      () =>
        readyPlanAt(fixture, new Date(plan.proofIssuedAt.getTime() + 62_000)),
      /not a valid transactional state/
    );
    assert.equal(reservations.replaceCalls, reservationWrites);
    assert.equal(
      (
        await fixture.db
          .collection(MANIFEST_COLLECTION)
          .findOne({ _id: REPAIR_ID })
      ).state,
      "backed_up"
    );
  }
  {
    const fixture = await preparedFixture();
    const plan = await readyPlan(fixture);
    const manifests = fixture.db.collection(MANIFEST_COLLECTION);
    manifests.beforeReplace = ({ replacement }) => {
      if (replacement._id === REPAIR_ID && replacement.state === "applied") {
        throw new Error("simulated post-reservation crash");
      }
    };
    await assert.rejects(
      () => applyPlanThroughMain(fixture, plan),
      /exact manifest CAS did not commit/
    );
    manifests.beforeReplace = null;
    const live = await fixture.db
      .collection(COLLECTIONS.reservation)
      .findOne({ _id: oid(TARGET.reservationMongoId) });
    assert.equal(canonicalEjsonSha256(live), plan.expectedHash);
    assert.equal(
      (await manifests.findOne({ _id: REPAIR_ID })).state,
      "applied_pending_postverify"
    );
    const resumed = await readyPlanAt(
      fixture,
      new Date(plan.proofIssuedAt.getTime() + 25 * 60 * 60_000)
    );
    assert.equal(resumed.resumeState, "applied_pending_postverify");
    const result = await applyPlanThroughMain(fixture, resumed);
    assert.equal(result.changed, 0);
    assert.equal(result.resumed, true);
    assert.equal(
      (await manifests.findOne({ _id: REPAIR_ID })).state,
      "applied"
    );
  }
});

test("manifest transition acknowledgement loss is read back without duplicate writes", async () => {
  const fixture = await preparedFixture();
  const plan = await readyPlan(fixture);
  const manifests = fixture.db.collection(MANIFEST_COLLECTION);
  manifests.afterReplace = () => {
    throw new Error("simulated lost manifest acknowledgement");
  };
  const result = await applyPlanThroughMain(fixture, plan);
  manifests.afterReplace = null;
  assert.equal(result.state, "applied");
  assert.equal((await manifests.findOne({ _id: REPAIR_ID })).state, "applied");
  assert.equal(
    fixture.db.collection(COLLECTIONS.reservation).replaceCalls,
    2,
    "only v1 and v2 reservation replacements occurred"
  );
});

test("transient postverify reads leave pending and resume without a second reservation write", async () => {
  const fixture = await preparedFixture();
  const plan = await readyPlan(fixture);
  const reservations = fixture.db.collection(COLLECTIONS.reservation);
  const portalJobs = fixture.db.collection(COLLECTIONS.portalJob);
  reservations.afterReplace = () => {
    portalJobs.beforeFindOne = () => {
      portalJobs.beforeFindOne = null;
      throw new Error("transient postverify read");
    };
    reservations.afterReplace = null;
  };
  await assert.rejects(
    () => applyPlanThroughMain(fixture, plan),
    /transient postverify read/
  );
  const writesAfterStage = reservations.replaceCalls;
  assert.equal(
    (
      await fixture.db
        .collection(MANIFEST_COLLECTION)
        .findOne({ _id: REPAIR_ID })
    ).state,
    "applied_pending_postverify"
  );
  const resumed = await readyPlanAt(
    fixture,
    new Date(plan.proofIssuedAt.getTime() + 25 * 60 * 60_000)
  );
  assert.equal(resumed.resumeState, "applied_pending_postverify");
  const result = await applyPlanThroughMain(fixture, resumed);
  assert.equal(result.changed, 0);
  assert.equal(result.resumed, true);
  assert.equal(reservations.replaceCalls, writesAfterStage);
  assert.equal(
    (
      await fixture.db
        .collection(MANIFEST_COLLECTION)
        .findOne({ _id: REPAIR_ID })
    ).state,
    "applied"
  );
});

test("Mongo null/missing replacement-time races are rejected forward and rollback", async () => {
  {
    const fixture = await preparedFixture();
    const plan = await readyPlan(fixture);
    const reservations = fixture.db.collection(COLLECTIONS.reservation);
    reservations.beforeReplace = ({ collection }) => {
      delete collection.documents[0].commission_ota;
      collection.documents[0].concurrentRootKey = "forward-race";
      collection.beforeReplace = null;
    };
    await assert.rejects(
      () => applyPlanThroughMain(fixture, plan),
      /neither exact before nor exact after|atomic reservation and manifest transaction aborted/
    );
    assert.equal(reservations.documents[0].concurrentRootKey, "forward-race");
    assert.notEqual(
      canonicalEjsonSha256(reservations.documents[0]),
      plan.originalHash
    );
  }
  {
    const fixture = await preparedFixture();
    const plan = await readyPlan(fixture);
    await applyPlanThroughMain(fixture, plan);
    const rollback = await loadRollbackPlan({
      db: fixture.db,
      releaseSha: RELEASE_SHA,
      plannedAt: new Date(fixture.plannedAt.getTime() + 5 * 60_000),
      portalSelection: PORTAL_SELECTION,
      execution: CLEAN_EXECUTION,
    });
    const reservations = fixture.db.collection(COLLECTIONS.reservation);
    reservations.beforeReplace = ({ collection }) => {
      delete collection.documents[0].commission_ota;
      collection.documents[0].concurrentRootKey = "rollback-race";
      collection.beforeReplace = null;
    };
    await assert.rejects(
      () => rollbackPlanThroughMain(fixture, rollback),
      /neither exact before nor exact after|atomic reservation and manifest transaction aborted/
    );
    assert.equal(reservations.documents[0].concurrentRootKey, "rollback-race");
    assert.equal(
      (
        await fixture.db
          .collection(MANIFEST_COLLECTION)
          .findOne({ _id: REPAIR_ID })
      ).state,
      "rolling_back"
    );
  }
});

test("full-manifest CAS and backup reloads catch interleaved tampering", async () => {
  {
    const fixture = await preparedFixture();
    const plan = await readyPlan(fixture);
    const manifests = fixture.db.collection(MANIFEST_COLLECTION);
    manifests.beforeReplace = ({ collection, replacement }) => {
      if (replacement.state === "backed_up") {
        collection.documents.find(
          (entry) => entry._id === REPAIR_ID
        ).evidenceHash = "f".repeat(64);
      }
    };
    await assert.rejects(
      () => applyPlanThroughMain(fixture, plan),
      /manifest changed to an unapproved state/
    );
    assert.equal(
      canonicalEjsonSha256(
        fixture.db.collection(COLLECTIONS.reservation).documents[0]
      ),
      plan.originalHash
    );
  }
  {
    const fixture = await preparedFixture();
    const plan = await readyPlan(fixture);
    const manifests = fixture.db.collection(MANIFEST_COLLECTION);
    manifests.afterReplace = ({ replacement }) => {
      if (replacement.state === "backed_up") {
        fixture.db.collection(BACKUP_COLLECTION).documents[0].originalHash =
          "0".repeat(64);
      }
    };
    await assert.rejects(
      () => applyPlanThroughMain(fixture, plan),
      /backup record failed integrity|manifest no longer binds|manual intervention/
    );
    assert.equal(
      canonicalEjsonSha256(
        fixture.db.collection(COLLECTIONS.reservation).documents[0]
      ),
      plan.originalHash
    );
  }
  {
    const fixture = await preparedFixture();
    const plan = await readyPlan(fixture);
    await applyPlanThroughMain(fixture, plan);
    const rollback = await loadRollbackPlan({
      db: fixture.db,
      releaseSha: RELEASE_SHA,
      plannedAt: new Date(fixture.plannedAt.getTime() + 5 * 60_000),
      portalSelection: PORTAL_SELECTION,
      execution: CLEAN_EXECUTION,
    });
    const manifests = fixture.db.collection(MANIFEST_COLLECTION);
    manifests.afterReplace = ({ replacement }) => {
      if (replacement.state === "rolling_back") {
        fixture.db.collection(BACKUP_COLLECTION).documents.pop();
      }
    };
    await assert.rejects(
      () => rollbackPlanThroughMain(fixture, rollback),
      /backup must contain exactly four/
    );
    assert.equal(
      canonicalEjsonSha256(
        fixture.db.collection(COLLECTIONS.reservation).documents[0]
      ),
      plan.expectedHash
    );
  }
});

test("backup records are reloaded again after each reservation replacement", async () => {
  {
    const fixture = await preparedFixture();
    const plan = await readyPlan(fixture);
    const reservations = fixture.db.collection(COLLECTIONS.reservation);
    reservations.afterReplace = () => {
      fixture.db.collection(BACKUP_COLLECTION).documents[0].originalHash =
        "f".repeat(64);
      reservations.afterReplace = null;
    };
    await assert.rejects(
      () => applyPlanThroughMain(fixture, plan),
      /backup record failed integrity|manifest no longer binds|manual intervention/
    );
    assert.equal(
      canonicalEjsonSha256(reservations.documents[0]),
      plan.expectedHash
    );
    const failedManifest = await fixture.db
      .collection(MANIFEST_COLLECTION)
      .findOne({ _id: REPAIR_ID });
    assert.equal(failedManifest.state, "postverify_failed");
    assert.equal(failedManifest.postverifyAction, "forward");
    assert.equal(
      failedManifest.postverifyExpectedReservationHash,
      plan.expectedHash
    );
    assert.equal(
      failedManifest.postverifyObservedReservationHash,
      plan.expectedHash
    );
    assert.match(failedManifest.postverifyObservedHash, /^[a-f0-9]{64}$/);
    assert.match(
      failedManifest.postverifyPredecessorManifestHash,
      /^[a-f0-9]{64}$/
    );
    assert.equal(failedManifest.manualInterventionRequired, true);
    await assert.rejects(
      () => readyPlan(fixture),
      /durable manual-intervention/
    );
  }
  {
    const fixture = await preparedFixture();
    const forward = await readyPlan(fixture);
    await applyPlanThroughMain(fixture, forward);
    const rollback = await loadRollbackPlan({
      db: fixture.db,
      releaseSha: RELEASE_SHA,
      plannedAt: new Date(fixture.plannedAt.getTime() + 6 * 60_000),
      portalSelection: PORTAL_SELECTION,
      execution: CLEAN_EXECUTION,
    });
    const reservations = fixture.db.collection(COLLECTIONS.reservation);
    reservations.afterReplace = () => {
      fixture.db.collection(BACKUP_COLLECTION).documents[1].recordHash =
        "0".repeat(64);
      reservations.afterReplace = null;
    };
    await assert.rejects(
      () => rollbackPlanThroughMain(fixture, rollback),
      /backup record failed integrity|manifest no longer binds|manual intervention/
    );
    assert.equal(
      canonicalEjsonSha256(reservations.documents[0]),
      forward.originalHash
    );
    const failedManifest = await fixture.db
      .collection(MANIFEST_COLLECTION)
      .findOne({ _id: REPAIR_ID });
    assert.equal(failedManifest.state, "postverify_failed");
    assert.equal(failedManifest.postverifyAction, "rollback");
    assert.equal(
      failedManifest.postverifyExpectedReservationHash,
      forward.originalHash
    );
    assert.equal(
      failedManifest.postverifyObservedReservationHash,
      forward.originalHash
    );
    assert.match(failedManifest.postverifyObservedHash, /^[a-f0-9]{64}$/);
    assert.match(failedManifest.postverifyDriftScopeHash, /^[a-f0-9]{64}$/);
  }
});

test("expired proof and owner leases cannot suppress durable drift recording", async () => {
  {
    const fixture = await preparedFixture();
    const plan = await readyPlan(fixture);
    const reservations = fixture.db.collection(COLLECTIONS.reservation);
    const manifests = fixture.db.collection(MANIFEST_COLLECTION);
    let mutationClock = new Date(plan.proofIssuedAt.getTime() + 1_000);
    const expiredAt = new Date(plan.proofIssuedAt.getTime() + 31 * 60_000);
    reservations.beforeFindOne = ({ options }) => {
      if (
        !options.session &&
        manifests.documents.find((entry) => entry._id === REPAIR_ID)?.state ===
          "applied_pending_postverify"
      ) {
        fixture.db.collection(BACKUP_COLLECTION).documents[0].originalHash =
          "a".repeat(64);
        mutationClock = expiredAt;
        reservations.beforeFindOne = null;
      }
    };
    await assert.rejects(
      () =>
        applyPlanThroughMain(fixture, plan, {
          clock: () => mutationClock,
        }),
      /manual intervention/
    );
    const failed = await manifests.findOne({ _id: REPAIR_ID });
    assert.equal(failed.state, "postverify_failed");
    assert.equal(failed.postverifyAction, "forward");
    assert.equal(
      new Date(failed.postverifyFailedAt).getTime(),
      expiredAt.getTime()
    );
    assert.equal(failed.postverifyObservedReservationHash, plan.expectedHash);
  }
  {
    const fixture = await preparedFixture();
    const forward = await readyPlan(fixture);
    await applyPlanThroughMain(fixture, forward);
    const rollbackIssuedAt = new Date(fixture.plannedAt.getTime() + 8 * 60_000);
    const rollback = await loadRollbackPlan({
      db: fixture.db,
      releaseSha: RELEASE_SHA,
      plannedAt: rollbackIssuedAt,
      portalSelection: PORTAL_SELECTION,
      execution: CLEAN_EXECUTION,
    });
    const reservations = fixture.db.collection(COLLECTIONS.reservation);
    const manifests = fixture.db.collection(MANIFEST_COLLECTION);
    let mutationClock = new Date(rollback.proofIssuedAt.getTime() + 1_000);
    const expiredAt = new Date(rollback.proofIssuedAt.getTime() + 31 * 60_000);
    reservations.beforeFindOne = ({ options }) => {
      if (
        !options.session &&
        manifests.documents.find((entry) => entry._id === REPAIR_ID)?.state ===
          "rolled_back_pending_postverify"
      ) {
        fixture.db.collection(v1.BACKUP_COLLECTION).documents[0].recordHash =
          "b".repeat(64);
        mutationClock = expiredAt;
        reservations.beforeFindOne = null;
      }
    };
    await assert.rejects(
      () =>
        rollbackPlanThroughMain(fixture, rollback, {
          clock: () => mutationClock,
        }),
      /manual intervention/
    );
    const failed = await manifests.findOne({ _id: REPAIR_ID });
    assert.equal(failed.state, "postverify_failed");
    assert.equal(failed.postverifyAction, "rollback");
    assert.equal(
      new Date(failed.postverifyFailedAt).getTime(),
      expiredAt.getTime()
    );
    assert.equal(
      failed.postverifyObservedReservationHash,
      forward.originalHash
    );
  }
});

test("identity uniqueness is reverified in-snapshot and after commit", async () => {
  const duplicateId = "6a77f999cdbc8acbbe4968b7";
  {
    const fixture = await preparedFixture();
    const plan = await readyPlan(fixture);
    const reservations = fixture.db.collection(COLLECTIONS.reservation);
    const manifests = fixture.db.collection(MANIFEST_COLLECTION);
    manifests.afterReplace = ({ replacement }) => {
      if (replacement._id === REPAIR_ID && replacement.state === "backed_up") {
        const duplicate = cloneBson(reservations.documents[0]);
        duplicate._id = oid(duplicateId);
        reservations.documents.push(duplicate);
        manifests.afterReplace = null;
      }
    };
    await assert.rejects(
      () => applyPlanThroughMain(fixture, plan),
      /reservation uniqueness boundary/
    );
    assert.equal(
      canonicalEjsonSha256(reservations.documents[0]),
      plan.originalHash
    );
    assert.equal(reservations.documents.length, 2);
    assert.equal(
      (await manifests.findOne({ _id: REPAIR_ID })).state,
      "backed_up"
    );
  }
  {
    const fixture = await preparedFixture();
    const plan = await readyPlan(fixture);
    const reservations = fixture.db.collection(COLLECTIONS.reservation);
    const manifests = fixture.db.collection(MANIFEST_COLLECTION);
    reservations.beforeFindOne = ({ options }) => {
      if (
        !options.session &&
        manifests.documents.find((entry) => entry._id === REPAIR_ID)?.state ===
          "applied_pending_postverify"
      ) {
        const duplicate = cloneBson(reservations.documents[0]);
        duplicate._id = oid(duplicateId);
        reservations.documents.push(duplicate);
        reservations.beforeFindOne = null;
      }
    };
    await assert.rejects(
      () => applyPlanThroughMain(fixture, plan),
      /manual intervention/
    );
    const failed = await manifests.findOne({ _id: REPAIR_ID });
    assert.equal(failed.state, "postverify_failed");
    assert.equal(failed.postverifyDriftKind, "identity_uniqueness");
    assert.equal(failed.postverifyObservedReservationHash, plan.expectedHash);
    assert.equal(
      canonicalEjsonSha256(reservations.documents[0]),
      plan.expectedHash
    );
    assert.equal(reservations.documents.length, 2);
  }
});

test("mutation boundary rejects direct callers, dirty trees, changed trees, and non-primary DBs", async () => {
  {
    const fixture = await preparedFixture();
    const plan = await readyPlan(fixture);
    await assert.rejects(
      () => applyRepairPlan({ db: fixture.db, plan }),
      /authorized execution capability/
    );
    await assert.rejects(
      () => applyRepairPlan({ db: fixture.db, plan, capability: {} }),
      /authorized execution capability/
    );
    assert.equal(fixture.db.collection(BACKUP_COLLECTION).documents.length, 0);
  }
  for (const dirtyLabel of ["v2-script-dirty", "dependency-dirty"]) {
    const fixture = await preparedFixture();
    const plan = await readyPlan(fixture);
    await assert.rejects(
      () =>
        applyPlanThroughMain(fixture, plan, {
          executionAttestor: () => ({
            ...cloneBson(CLEAN_EXECUTION),
            trackedWorktreeClean: false,
            dirtyLabel,
          }),
        }),
      /tracked worktree or index change/
    );
    assert.equal(fixture.db.collection(BACKUP_COLLECTION).documents.length, 0);
  }
  {
    const fixture = await preparedFixture();
    const plan = await readyPlan(fixture);
    let attestations = 0;
    await assert.rejects(
      () =>
        applyPlanThroughMain(fixture, plan, {
          executionAttestor: () => {
            attestations += 1;
            return attestations === 1
              ? cloneBson(CLEAN_EXECUTION)
              : {
                  ...cloneBson(CLEAN_EXECUTION),
                  treeSha: "f".repeat(40),
                  executionFingerprint: "a".repeat(64),
                };
          },
        }),
      /executing tree changed/
    );
    assert.equal(fixture.db.collection(BACKUP_COLLECTION).documents.length, 0);
  }
  {
    const fixture = await preparedFixture();
    const plan = await readyPlan(fixture);
    fixture.db.isWritablePrimary = false;
    await assert.rejects(
      () => applyPlanThroughMain(fixture, plan),
      /writable MongoDB primary/
    );
    assert.equal(fixture.db.collection(BACKUP_COLLECTION).documents.length, 0);
  }
});

test("dirty entry attestation blocks dry-run and apply before every database read", async () => {
  const fixture = await preparedFixture();
  const plan = await readyPlan(fixture);
  let databaseReads = 0;
  const unreadableDb = {
    collection() {
      databaseReads += 1;
      throw new Error("database must remain unread");
    },
  };
  const dirtyAttestor = () => ({
    ...cloneBson(CLEAN_EXECUTION),
    trackedWorktreeClean: false,
  });
  for (const args of [
    baseArgs(),
    [
      "--apply",
      "--repair-id=" + REPAIR_ID,
      "--proof=" + proofToken(plan),
      ...baseArgs(),
    ],
  ]) {
    await assert.rejects(
      () =>
        main(args, {
          db: unreadableDb,
          clock: () => fixture.plannedAt,
          resolveReleaseSha: () => RELEASE_SHA,
          executionAttestor: dirtyAttestor,
        }),
      /tracked worktree or index change/
    );
  }
  assert.equal(databaseReads, 0);
});

test("terminal writes require replica or mongos transactions before any v2 artifact", async () => {
  const fixture = await preparedFixture();
  const plan = await readyPlan(fixture);
  fixture.db.transactionCapable = false;
  await assert.rejects(
    () => applyPlanThroughMain(fixture, plan),
    /transaction-capable replica set or mongos/
  );
  assert.equal(fixture.db.collection(BACKUP_COLLECTION).documents.length, 0);
  assert.equal(
    fixture.db
      .collection(MANIFEST_COLLECTION)
      .documents.some((entry) => entry._id === REPAIR_ID),
    false
  );
  assert.equal(
    canonicalEjsonSha256(
      fixture.db.collection(COLLECTIONS.reservation).documents[0]
    ),
    plan.originalHash
  );
});

test("forward and rollback transactions abort on concurrent reservation commits", async () => {
  {
    const fixture = await preparedFixture();
    const plan = await readyPlan(fixture);
    const manifests = fixture.db.collection(MANIFEST_COLLECTION);
    const reservations = fixture.db.collection(COLLECTIONS.reservation);
    manifests.beforeReplace = ({ replacement }) => {
      if (
        replacement._id === REPAIR_ID &&
        replacement.state === "applied_pending_postverify"
      ) {
        reservations.documents[0].concurrentTerminalWrite = "forward";
        manifests.beforeReplace = null;
      }
    };
    await assert.rejects(
      () => applyPlanThroughMain(fixture, plan),
      /atomic reservation and manifest transaction aborted/
    );
    assert.equal(
      (await manifests.findOne({ _id: REPAIR_ID })).state,
      "backed_up"
    );
    assert.equal(reservations.documents[0].concurrentTerminalWrite, "forward");
    assert.notEqual(
      canonicalEjsonSha256(reservations.documents[0]),
      plan.expectedHash
    );
  }
  {
    const fixture = await preparedFixture();
    const forward = await readyPlan(fixture);
    await applyPlanThroughMain(fixture, forward);
    const rollback = await loadRollbackPlan({
      db: fixture.db,
      releaseSha: RELEASE_SHA,
      plannedAt: new Date(fixture.plannedAt.getTime() + 6 * 60_000),
      portalSelection: PORTAL_SELECTION,
      execution: CLEAN_EXECUTION,
    });
    const manifests = fixture.db.collection(MANIFEST_COLLECTION);
    const reservations = fixture.db.collection(COLLECTIONS.reservation);
    manifests.beforeReplace = ({ replacement }) => {
      if (replacement.state === "rolled_back_pending_postverify") {
        reservations.documents[0].concurrentTerminalWrite = "rollback";
        manifests.beforeReplace = null;
      }
    };
    await assert.rejects(
      () => rollbackPlanThroughMain(fixture, rollback),
      /atomic reservation and manifest transaction aborted/
    );
    assert.equal(
      (await manifests.findOne({ _id: REPAIR_ID })).state,
      "rolling_back"
    );
    assert.equal(reservations.documents[0].concurrentTerminalWrite, "rollback");
    assert.notEqual(
      canonicalEjsonSha256(reservations.documents[0]),
      forward.originalHash
    );
  }
});

test("postcommit drift becomes durable manual state without protected overwrite", async () => {
  {
    const fixture = await preparedFixture();
    const plan = await readyPlan(fixture);
    const reservations = fixture.db.collection(COLLECTIONS.reservation);
    const portalJobs = fixture.db.collection(COLLECTIONS.portalJob);
    reservations.afterReplace = () => {
      const index = portalJobs.documents.findIndex(
        (job) => String(job._id) === PORTAL_SELECTION.jobId
      );
      portalJobs.documents.splice(index, 1);
      reservations.afterReplace = null;
    };
    await assert.rejects(
      () => applyPlanThroughMain(fixture, plan),
      /manual intervention/
    );
    assert.equal(
      canonicalEjsonSha256(reservations.documents[0]),
      plan.expectedHash
    );
    assert.equal(
      portalJobs.documents.some(
        (job) => String(job._id) === PORTAL_SELECTION.jobId
      ),
      false
    );
    assert.equal(
      (
        await fixture.db
          .collection(MANIFEST_COLLECTION)
          .findOne({ _id: REPAIR_ID })
      ).state,
      "postverify_failed"
    );
  }
  {
    const fixture = await preparedFixture();
    const forward = await readyPlan(fixture);
    await applyPlanThroughMain(fixture, forward);
    const rollback = await loadRollbackPlan({
      db: fixture.db,
      releaseSha: RELEASE_SHA,
      plannedAt: new Date(fixture.plannedAt.getTime() + 6 * 60_000),
      portalSelection: PORTAL_SELECTION,
      execution: CLEAN_EXECUTION,
    });
    const reservations = fixture.db.collection(COLLECTIONS.reservation);
    const v1Backups = fixture.db.collection(v1.BACKUP_COLLECTION);
    reservations.afterReplace = () => {
      v1Backups.documents.splice(0, 1);
      reservations.afterReplace = null;
    };
    await assert.rejects(
      () => rollbackPlanThroughMain(fixture, rollback),
      /manual intervention/
    );
    assert.equal(
      canonicalEjsonSha256(reservations.documents[0]),
      forward.originalHash
    );
    assert.equal(v1Backups.documents.length, 3);
    assert.equal(
      (
        await fixture.db
          .collection(MANIFEST_COLLECTION)
          .findOne({ _id: REPAIR_ID })
      ).state,
      "postverify_failed"
    );
  }
});

test("tampered v1 manifest or backup prevents v2 planning and application", async () => {
  {
    const fixture = await preparedFixture();
    const record = fixture.db.collection(v1.BACKUP_COLLECTION).documents[0];
    record.originalDocument.state = "tampered";
    await assert.rejects(() => readyPlan(fixture), /integrity failed/);
  }
  {
    const fixture = await preparedFixture();
    fixture.db.collection(
      COLLECTIONS.event
    ).documents[0].payload.reservation.total = 999;
    await assert.rejects(() => readyPlan(fixture), /immutable archive/);
  }
  {
    const fixture = await preparedFixture();
    const plan = await readyPlan(fixture);
    const manifest = fixture.db
      .collection(v1.MANIFEST_COLLECTION)
      .documents.find((entry) => entry._id === v1.REPAIR_ID);
    manifest.evidenceHash = "0".repeat(64);
    await assert.rejects(
      () => applyPlanThroughMain(fixture, plan),
      /v1 post-state cannot be reconstructed|v1 predecessor proof changed/
    );
    assert.equal(
      fixture.db.collection(COLLECTIONS.reservation).replaceCalls,
      1
    );
  }
});

test("coherently rehashed v2 reservation backup cannot redefine the v1 rollback target", async () => {
  const fixture = await preparedFixture();
  const forward = await readyPlan(fixture);
  await applyPlanThroughMain(fixture, forward);
  const backups = fixture.db.collection(BACKUP_COLLECTION).documents;
  const recordIndex = backups.findIndex(
    (record) => record.role === "reservation_before"
  );
  const originalRecord = backups[recordIndex];
  const forgedDocument = cloneBson(originalRecord.originalDocument);
  forgedDocument.total_amount = Number(forgedDocument.total_amount) + 1;
  const forgedRecord = repairApi.backupRecord({
    role: originalRecord.role,
    collection: originalRecord.sourceCollection,
    document: forgedDocument,
    expectedRepairedHash: originalRecord.expectedRepairedHash,
    capturedAt: originalRecord.capturedAt,
  });
  backups[recordIndex] = forgedRecord;
  const manifest = fixture.db
    .collection(MANIFEST_COLLECTION)
    .documents.find((entry) => entry._id === REPAIR_ID);
  manifest.originalHash = forgedRecord.originalHash;
  manifest.backupRecordHashes.reservation_before = forgedRecord.recordHash;
  manifest.backupSetSha256 = canonicalEjsonSha256(
    backups
      .map((record) => ({ id: record._id, recordHash: record.recordHash }))
      .sort((left, right) => left.id.localeCompare(right.id))
  );
  const reservationWritesBefore = fixture.db.collection(
    COLLECTIONS.reservation
  ).replaceCalls;
  await assert.rejects(
    () =>
      loadRollbackPlan({
        db: fixture.db,
        releaseSha: RELEASE_SHA,
        plannedAt: new Date(fixture.plannedAt.getTime() + 6 * 60_000),
        portalSelection: PORTAL_SELECTION,
        execution: CLEAN_EXECUTION,
      }),
    /independently reconstructed v1 lineage/
  );
  assert.equal(
    fixture.db.collection(COLLECTIONS.reservation).replaceCalls,
    reservationWritesBefore
  );
  assert.equal(manifest.state, "applied");
});

test("rollback restores exact v1 EJSON and is idempotent without touching v1 proof", async () => {
  const fixture = await preparedFixture();
  const plan = await readyPlan(fixture);
  const v1DocumentHash = plan.originalHash;
  const v1ManifestBefore = canonicalEjsonSha256(
    await fixture.db
      .collection(v1.MANIFEST_COLLECTION)
      .findOne({ _id: v1.REPAIR_ID })
  );
  const v1BackupsBefore = canonicalEjsonSha256(
    fixture.db.collection(v1.BACKUP_COLLECTION).documents
  );
  await applyPlanThroughMain(fixture, plan);
  const rollbackAt = new Date(fixture.plannedAt.getTime() + 10 * 60_000);
  const rollback = await loadRollbackPlan({
    db: fixture.db,
    releaseSha: RELEASE_SHA,
    plannedAt: rollbackAt,
    portalSelection: PORTAL_SELECTION,
    execution: CLEAN_EXECUTION,
  });
  assert.equal(rollback.state, "ready");
  const result = await rollbackPlanThroughMain(fixture, rollback);
  assert.equal(result.state, "rolled_back");
  assert.equal(result.changed, 1);
  const restored = await fixture.db
    .collection(COLLECTIONS.reservation)
    .findOne({ _id: oid(TARGET.reservationMongoId) });
  assert.equal(canonicalEjsonSha256(restored), v1DocumentHash);
  assert.equal(restored.__v, 2);
  assert.equal(
    restored.supplierData.otaCommercialRepair.repairId,
    v1.REPAIR_ID
  );
  assert.equal(
    restored.supplierData.otaCommercialMaterializationRepair,
    undefined
  );
  assert.equal(
    canonicalEjsonSha256(
      await fixture.db
        .collection(v1.MANIFEST_COLLECTION)
        .findOne({ _id: v1.REPAIR_ID })
    ),
    v1ManifestBefore
  );
  assert.equal(
    canonicalEjsonSha256(fixture.db.collection(v1.BACKUP_COLLECTION).documents),
    v1BackupsBefore
  );
  const reservationWrites = fixture.db.collection(
    COLLECTIONS.reservation
  ).replaceCalls;
  const delayedRollbackAt = new Date(rollbackAt.getTime() + 25 * 60 * 60_000);
  const portalJobs = fixture.db.collection(COLLECTIONS.portalJob);
  portalJobs.beforeFindOne = () => {
    portalJobs.beforeFindOne = null;
    throw new Error("transient rolled-back verification read");
  };
  await assert.rejects(
    () =>
      loadRollbackPlan({
        db: fixture.db,
        releaseSha: RELEASE_SHA,
        plannedAt: delayedRollbackAt,
        portalSelection: PORTAL_SELECTION,
        execution: CLEAN_EXECUTION,
      }),
    /transient rolled-back verification read/
  );
  const rerun = await loadRollbackPlan({
    db: fixture.db,
    releaseSha: RELEASE_SHA,
    plannedAt: new Date(delayedRollbackAt.getTime() + 60_000),
    portalSelection: PORTAL_SELECTION,
    execution: CLEAN_EXECUTION,
  });
  assert.equal(rerun.state, "already_rolled_back");
  const idempotent = await rollbackPlanThroughMain(fixture, rerun);
  assert.equal(idempotent.changed, 0);
  assert.equal(
    fixture.db.collection(COLLECTIONS.reservation).replaceCalls,
    reservationWrites
  );
});

test("rollback blocks a legacy split commit without a second target write", async () => {
  const fixture = await preparedFixture();
  const forward = await readyPlan(fixture);
  await applyPlanThroughMain(fixture, forward);
  const reservations = fixture.db.collection(COLLECTIONS.reservation);
  reservations.documents[0] = cloneBson(forward.originalDocument);
  const reservationWrites = reservations.replaceCalls;
  await assert.rejects(
    () =>
      loadRollbackPlan({
        db: fixture.db,
        releaseSha: RELEASE_SHA,
        plannedAt: new Date(fixture.plannedAt.getTime() + 10 * 60_000),
        portalSelection: PORTAL_SELECTION,
        execution: CLEAN_EXECUTION,
      }),
    /not a valid transactional state/
  );
  assert.equal(reservations.replaceCalls, reservationWrites);
  assert.equal(
    (
      await fixture.db
        .collection(MANIFEST_COLLECTION)
        .findOne({ _id: REPAIR_ID })
    ).state,
    "applied"
  );
});

test("rollback resumes long-delayed pending postverification with fresh proof fields", async () => {
  const fixture = await preparedFixture();
  const forward = await readyPlan(fixture);
  await applyPlanThroughMain(fixture, forward);
  const rollbackIssuedAt = new Date(fixture.plannedAt.getTime() + 8 * 60_000);
  const rollback = await loadRollbackPlan({
    db: fixture.db,
    releaseSha: RELEASE_SHA,
    plannedAt: rollbackIssuedAt,
    portalSelection: PORTAL_SELECTION,
    execution: CLEAN_EXECUTION,
  });
  const manifests = fixture.db.collection(MANIFEST_COLLECTION);
  manifests.beforeReplace = ({ replacement }) => {
    if (replacement.state === "rolled_back") {
      throw new Error("simulated rollback finalization crash");
    }
  };
  await assert.rejects(
    () => rollbackPlanThroughMain(fixture, rollback),
    /exact manifest CAS did not commit/
  );
  manifests.beforeReplace = null;
  assert.equal(
    (await manifests.findOne({ _id: REPAIR_ID })).state,
    "rolled_back_pending_postverify"
  );
  assert.equal(
    canonicalEjsonSha256(
      fixture.db.collection(COLLECTIONS.reservation).documents[0]
    ),
    forward.originalHash
  );
  const resumedIssuedAt = new Date(
    rollbackIssuedAt.getTime() + 25 * 60 * 60_000
  );
  const resumed = await loadRollbackPlan({
    db: fixture.db,
    releaseSha: RELEASE_SHA,
    plannedAt: resumedIssuedAt,
    portalSelection: PORTAL_SELECTION,
    execution: CLEAN_EXECUTION,
  });
  assert.equal(resumed.resumeState, "rolled_back_pending_postverify");
  const result = await rollbackPlanThroughMain(fixture, resumed);
  assert.equal(result.changed, 0);
  assert.equal(result.resumed, true);
  const manifest = await manifests.findOne({ _id: REPAIR_ID });
  assert.equal(manifest.state, "rolled_back");
  assert.equal(manifest.rollbackPlanHash, resumed.planHash);
  assert.equal(manifest.rollbackScopeHash, resumed.rollbackScopeHash);
  assert.equal(manifest.rollbackAttemptNumber, 2);
  assert.equal(
    new Date(manifest.rollbackProofIssuedAt).getTime(),
    resumedIssuedAt.getTime()
  );
  assert.equal(
    new Date(manifest.rollbackProofExpiresAt).getTime(),
    resumedIssuedAt.getTime() + 30 * 60_000
  );
});

test("an unexpired owner lease cannot be stolen by a second forward attempt", async () => {
  const fixture = await preparedFixture();
  const plan = await readyPlan(fixture);
  const reservations = fixture.db.collection(COLLECTIONS.reservation);
  reservations.beforeReplace = () => {
    throw new Error("leave backed-up state");
  };
  await assert.rejects(() => applyPlanThroughMain(fixture, plan));
  reservations.beforeReplace = null;
  const retryIssuedAt = new Date(plan.proofIssuedAt.getTime() + 10_000);
  const retry = await readyPlanAt(fixture, retryIssuedAt);
  await assert.rejects(
    () => applyPlanThroughMain(fixture, retry),
    /unexpired manifest lease/
  );
  assert.equal(
    canonicalEjsonSha256(reservations.documents[0]),
    plan.originalHash
  );
});

test("proof and evidence ages are rechecked against the actual mutation clock", async () => {
  {
    const fixture = await preparedFixture();
    const plan = await readyPlan(fixture);
    let clockCalls = 0;
    const beforeExpiry = new Date(plan.proofIssuedAt.getTime() + 29 * 60_000);
    const afterExpiry = new Date(
      plan.proofIssuedAt.getTime() + 30 * 60_000 + 1
    );
    await assert.rejects(
      () =>
        applyPlanThroughMain(fixture, plan, {
          clock: () => {
            clockCalls += 1;
            return clockCalls <= 4 ? beforeExpiry : afterExpiry;
          },
        }),
      /proof expired/
    );
    assert.equal(
      canonicalEjsonSha256(
        fixture.db.collection(COLLECTIONS.reservation).documents[0]
      ),
      plan.originalHash
    );
    const resumedIssuedAt = new Date(afterExpiry.getTime() + 1_000);
    const resumed = await readyPlanAt(fixture, resumedIssuedAt);
    assert.equal(
      (await applyPlanThroughMain(fixture, resumed)).state,
      "applied"
    );
  }
  {
    const fixture = await preparedFixture();
    const finishedAt = new Date(
      fixture.db.collection(
        COLLECTIONS.portalJob
      ).documents[1].collectorState.finishedAt
    );
    const issuedAt = new Date(finishedAt.getTime() + 24 * 60 * 60_000 - 60_000);
    const plan = await readyPlanAt(fixture, issuedAt);
    await assert.rejects(
      () =>
        applyPlanThroughMain(fixture, plan, {
          now: new Date(issuedAt.getTime() + 2 * 60_000),
        }),
      /expired before reservation CAS/
    );
    assert.equal(
      canonicalEjsonSha256(
        fixture.db.collection(COLLECTIONS.reservation).documents[0]
      ),
      plan.originalHash
    );
  }
  {
    const fixture = await preparedFixture();
    const job = fixture.db.collection(COLLECTIONS.portalJob).documents[1];
    const candidate = job.previewBuckets.matchedExisting[0];
    const convertedAt = new Date(candidate.amountConvertedAt);
    const sourceTimestamp = new Date(
      convertedAt.getTime() - (7 * 24 * 60 * 60_000 - 30_000)
    );
    const rate = candidate.currencyConversionEvidence.rate;
    const sourceHash = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          provider: "exchange_rate_api",
          sourceType: "trusted_exchange_evidence",
          sourceCurrency: "USD",
          propertyCurrency: "SAR",
          rate,
          sourceTimestamp: sourceTimestamp.toISOString(),
        })
      )
      .digest("hex");
    candidate.currencyConversionEvidence.provenance.sourceTimestamp =
      sourceTimestamp.toISOString();
    candidate.currencyConversionEvidence.provenance.sourceHash = sourceHash;
    candidate.currencyConversionEvidence.provenance.sourceId =
      "exchange-rate-api-usd-sar-" + sourceHash.slice(0, 24);
    job.previewBuckets.paymentOrVccAvailable[0].currencyConversionEvidence =
      cloneBson(candidate.currencyConversionEvidence);
    const plan = await readyPlan(fixture);
    await assert.rejects(
      () => applyPlanThroughMain(fixture, plan),
      /expired before reservation CAS/
    );
    assert.equal(
      canonicalEjsonSha256(
        fixture.db.collection(COLLECTIONS.reservation).documents[0]
      ),
      plan.originalHash
    );
  }
});

test("rollback dry-run proof is required and applies only its exact release/scope", async () => {
  const fixture = await preparedFixture();
  const baseArgs = [
    "--release-sha=" + RELEASE_SHA,
    "--portal-job-id=" + PORTAL_SELECTION.jobId,
    "--portal-job-number=" + PORTAL_SELECTION.jobNumber,
  ];
  const messages = [];
  const originalLog = console.log;
  console.log = (value) => messages.push(String(value));
  try {
    const dry = await main(baseArgs, {
      db: fixture.db,
      clock: () => fixture.plannedAt,
      resolveReleaseSha: () => RELEASE_SHA,
      executionAttestor: cleanExecutionAttestor,
    });
    const applied = await main(
      [
        "--apply",
        "--repair-id=" + REPAIR_ID,
        "--proof=" + dry.proof,
        ...baseArgs,
      ],
      {
        db: fixture.db,
        clock: () => new Date(fixture.plannedAt.getTime() + 60_000),
        resolveReleaseSha: () => RELEASE_SHA,
        executionAttestor: cleanExecutionAttestor,
      }
    );
    assert.equal(applied.state, "applied");
    const rollbackDry = await main(
      ["--rollback", "--repair-id=" + REPAIR_ID, ...baseArgs],
      {
        db: fixture.db,
        clock: () => new Date(fixture.plannedAt.getTime() + 120_000),
        resolveReleaseSha: () => RELEASE_SHA,
        executionAttestor: cleanExecutionAttestor,
      }
    );
    assert.equal(rollbackDry.state, "rollback_dry_run_ready");
    await assert.rejects(
      () =>
        main(
          [
            "--rollback",
            "--apply",
            "--repair-id=" + REPAIR_ID,
            "--proof=" +
              rollbackDry.proof.replace(/[a-f0-9]$/, (value) =>
                value === "0" ? "1" : "0"
              ),
            ...baseArgs,
          ],
          {
            db: fixture.db,
            clock: () => new Date(fixture.plannedAt.getTime() + 180_000),
            resolveReleaseSha: () => RELEASE_SHA,
            executionAttestor: cleanExecutionAttestor,
          }
        ),
      /proof/
    );
    const rolledBack = await main(
      [
        "--rollback",
        "--apply",
        "--repair-id=" + REPAIR_ID,
        "--proof=" + rollbackDry.proof,
        ...baseArgs,
      ],
      {
        db: fixture.db,
        clock: () => new Date(fixture.plannedAt.getTime() + 180_000),
        resolveReleaseSha: () => RELEASE_SHA,
        executionAttestor: cleanExecutionAttestor,
      }
    );
    assert.equal(rolledBack.state, "rolled_back");
  } finally {
    console.log = originalLog;
  }
  assert.equal(
    canonicalEjsonSha256(
      await fixture.db
        .collection(COLLECTIONS.reservation)
        .findOne({ _id: oid(TARGET.reservationMongoId) })
    ),
    fixture.v1Plan.expectedHash
  );
});

test("dry-run main emits only hashes and commercial values, never target PII or source text", async () => {
  const fixture = await preparedFixture();
  const messages = [];
  const originalLog = console.log;
  console.log = (value) => messages.push(String(value));
  try {
    const result = await main(
      [
        "--release-sha=" + RELEASE_SHA,
        "--portal-job-id=" + PORTAL_SELECTION.jobId,
        "--portal-job-number=" + PORTAL_SELECTION.jobNumber,
      ],
      {
        db: fixture.db,
        clock: () => fixture.plannedAt,
        resolveReleaseSha: () => RELEASE_SHA,
        executionAttestor: cleanExecutionAttestor,
      }
    );
    assert.equal(result.state, "dry_run_ready");
  } finally {
    console.log = originalLog;
  }
  const output = messages.join("\n");
  for (const secret of [
    TARGET.reservationMongoId,
    TARGET.pmsConfirmationNumber,
    TARGET.otaBookingId,
    TARGET.eventId,
    TARGET.mirrorId,
    PORTAL_SELECTION.jobId,
    PORTAL_SELECTION.jobNumber,
    "PRIVATE TEST GUEST",
    "PRIVATE SOURCE CONTENT",
  ]) {
    assert.equal(
      output.includes(secret),
      false,
      "output leaked scoped/private data"
    );
  }
  const plan = await readyPlan(fixture);
  const sanitized = JSON.stringify(
    sanitizedForwardOutput(plan, "dry_run", proofToken(plan))
  );
  assert.equal(sanitized.includes(TARGET.otaBookingId), false);
  assert.equal(sanitized.includes(PORTAL_SELECTION.jobNumber), false);
});

test("every CLI mode and failure returns only bounded non-PII projections", async () => {
  const fixture = await preparedFixture();
  const messages = [];
  const values = [];
  const originalLog = console.log;
  console.log = (value) => messages.push(String(value));
  const dependencies = (at) => ({
    db: fixture.db,
    clock: () => new Date(at),
    resolveReleaseSha: () => RELEASE_SHA,
    executionAttestor: cleanExecutionAttestor,
  });
  try {
    const dry = await main(baseArgs(), dependencies(fixture.plannedAt));
    values.push(dry);
    const forwardArgs = [
      "--apply",
      "--repair-id=" + REPAIR_ID,
      "--proof=" + dry.proof,
      ...baseArgs(),
    ];
    values.push(
      await main(
        forwardArgs,
        dependencies(new Date(fixture.plannedAt.getTime() + 1_000))
      )
    );
    values.push(
      await main(
        forwardArgs,
        dependencies(new Date(fixture.plannedAt.getTime() + 2_000))
      )
    );
    const rollbackDry = await main(
      ["--rollback", "--repair-id=" + REPAIR_ID, ...baseArgs()],
      dependencies(new Date(fixture.plannedAt.getTime() + 3 * 60_000))
    );
    values.push(rollbackDry);
    values.push(
      await main(
        [
          "--rollback",
          "--apply",
          "--repair-id=" + REPAIR_ID,
          "--proof=" + rollbackDry.proof,
          ...baseArgs(),
        ],
        dependencies(new Date(fixture.plannedAt.getTime() + 3 * 60_000 + 1_000))
      )
    );
    values.push(
      await main(
        ["--rollback", "--repair-id=" + REPAIR_ID, ...baseArgs()],
        dependencies(new Date(fixture.plannedAt.getTime() + 4 * 60_000))
      )
    );
    const failedFixture = await preparedFixture();
    try {
      await main(
        [
          "--apply",
          "--repair-id=" + REPAIR_ID,
          "--proof=" +
            dry.proof.replace(/[a-f0-9]$/, (value) =>
              value === "0" ? "1" : "0"
            ),
          ...baseArgs(),
        ],
        {
          db: failedFixture.db,
          clock: () => failedFixture.plannedAt,
          resolveReleaseSha: () => RELEASE_SHA,
          executionAttestor: cleanExecutionAttestor,
        }
      );
      assert.fail("bad proof unexpectedly succeeded");
    } catch (error) {
      values.push({ message: error.message, code: error.code });
    }
  } finally {
    console.log = originalLog;
  }
  const serialized = JSON.stringify({ values, messages });
  for (const secret of [
    TARGET.reservationMongoId,
    TARGET.pmsConfirmationNumber,
    TARGET.otaBookingId,
    TARGET.eventId,
    TARGET.mirrorId,
    PORTAL_SELECTION.jobId,
    PORTAL_SELECTION.jobNumber,
    "PRIVATE TEST GUEST",
    "PRIVATE SOURCE CONTENT",
    "must-survive",
  ]) {
    assert.equal(serialized.includes(secret), false, "CLI result leaked PII");
  }
  for (const value of values) {
    assert.equal(Object.prototype.hasOwnProperty.call(value, "plan"), false);
  }
});
