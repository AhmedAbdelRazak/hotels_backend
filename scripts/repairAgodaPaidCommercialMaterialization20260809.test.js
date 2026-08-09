/** @format */

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { ObjectId } = require("bson");

const {
  BACKUP_COLLECTION,
  COLLECTIONS,
  EXACT_TARGETS,
  EXPECTED_HOTEL_ID,
  MANIFEST_COLLECTION,
  PROOF_MAX_AGE_MS,
  REPAIR_ID,
  REQUIRED_MATCH_FIELDS,
  applyRepairPlan,
  buildBackupRecords,
  buildFullDocumentCasFilter,
  buildManifest,
  canonicalEjsonSha256,
  commercialRows,
  createMutationCapability,
  immutableRemainder,
  loadPlan,
  normalizedFromAudit,
  parseArguments,
  parseProof,
  paymentSettlementSnapshot,
  proofToken,
  rootBaseSnapshot,
  seedMirrorSourcePrices,
  sha256,
  verifyBackupRecords,
} = require("./repairAgodaPaidCommercialMaterialization20260809");
const {
  buildHotelRunnerEmailCommercialEvidence,
} = require("../services/otaReservationMapper");
const {
  canonicalEjson,
  cloneBson,
} = require("../services/tripHotelRunnerRepair20260805");

const RELEASE_SHA = "a".repeat(40);
const EXECUTION = Object.freeze({
  releaseSha: RELEASE_SHA,
  treeSha: "b".repeat(40),
  executionFingerprint: "c".repeat(64),
  trackedWorktreeClean: true,
});
const PLANNED_AT = new Date("2026-08-09T06:00:00.000Z");
const OWNER_ID = new ObjectId("68b74714fb50e159d48c714d");

const round2 = (value) => Number(Number(value).toFixed(2));
const id = (value) => String(value?._id || value || "");

function longDate(ymd) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${ymd}T00:00:00.000Z`));
}

function dateRange(checkin, checkout) {
  const dates = [];
  for (
    let cursor = new Date(`${checkin}T00:00:00.000Z`);
    cursor < new Date(`${checkout}T00:00:00.000Z`);
    cursor = new Date(cursor.getTime() + 86_400_000)
  ) {
    dates.push(cursor.toISOString().slice(0, 10));
  }
  return dates;
}

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
    current[part] ||= {};
    current = current[part];
  }
  current[parts.at(-1)] = cloneBson(value);
}

function unsetPath(object, pathText) {
  const parts = String(pathText).split(".");
  let current = object;
  for (const part of parts.slice(0, -1)) {
    current = current?.[part];
    if (!current) return;
  }
  delete current[parts.at(-1)];
}

function valuesEqual(left, right) {
  if (left instanceof Date || right instanceof Date) {
    return new Date(left).getTime() === new Date(right).getTime();
  }
  if (left instanceof ObjectId || right instanceof ObjectId) {
    return id(left) === id(right);
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
        const expectedKeys =
          entry.$expr?.$and?.[1]?.$setEquals?.[1] || rootKeys;
        const expectedSize =
          entry.$expr?.$and?.[0]?.$eq?.[1] ?? rootKeys.length;
        return (
          rootKeys.length === expectedSize &&
          canonicalEjsonSha256(rootKeys) === canonicalEjsonSha256(expectedKeys)
        );
      }
      return matches(document, entry);
    });
  }
  if (Array.isArray(filter.$or)) {
    if (!filter.$or.some((entry) => matches(document, entry))) return false;
  }
  return Object.entries(filter).every(([key, expected]) => {
    if (["$and", "$or", "$expr"].includes(key)) return true;
    const actual = getPath(document, key);
    if (
      expected &&
      typeof expected === "object" &&
      !(expected instanceof Date) &&
      !(expected instanceof ObjectId) &&
      !Array.isArray(expected)
    ) {
      if (Object.prototype.hasOwnProperty.call(expected, "$exists")) {
        return (actual !== undefined) === expected.$exists;
      }
      if (Array.isArray(expected.$in)) {
        return expected.$in.some((entry) => valuesEqual(actual, entry));
      }
    }
    return valuesEqual(actual, expected);
  });
}

class MemoryCollection {
  constructor(documents = [], { replaceHook = null } = {}) {
    this.documents = documents.map(cloneBson);
    this.replaceHook = replaceHook;
    this.replaceCalls = 0;
  }

  find(filter) {
    const matchesNow = this.documents
      .filter((document) => matches(document, filter))
      .map(cloneBson);
    return {
      limit(limit) {
        return {
          async toArray() {
            return matchesNow.slice(0, limit);
          },
        };
      },
    };
  }

  async findOne(filter) {
    const found = this.documents.find((document) => matches(document, filter));
    return found ? cloneBson(found) : null;
  }

  async insertOne(document) {
    if (this.documents.some((item) => valuesEqual(item._id, document._id))) {
      const error = new Error("duplicate key");
      error.code = 11000;
      throw error;
    }
    this.documents.push(cloneBson(document));
    return { acknowledged: true, insertedId: document._id };
  }

  async replaceOne(filter, replacement) {
    this.replaceCalls += 1;
    const index = this.documents.findIndex((document) => matches(document, filter));
    const commit = () => {
      if (index < 0) {
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
      }
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

  async updateOne(filter, update) {
    const document = this.documents.find((item) => matches(item, filter));
    if (!document) {
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
    }
    for (const [pathText, value] of Object.entries(update.$set || {})) {
      setPath(document, pathText, value);
    }
    for (const pathText of Object.keys(update.$unset || {})) {
      unsetPath(document, pathText);
    }
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  }
}

function memoryDb(fixtures, { replaceHook = null, duplicateReservation = null } = {}) {
  const collections = new Map([
    [
      COLLECTIONS.reservation,
      new MemoryCollection(
        [
          ...fixtures.map((fixture) => fixture.reservation),
          ...(duplicateReservation ? [duplicateReservation] : []),
        ],
        { replaceHook }
      ),
    ],
    [
      COLLECTIONS.event,
      new MemoryCollection(fixtures.map((fixture) => fixture.event)),
    ],
    [
      COLLECTIONS.mirror,
      new MemoryCollection(fixtures.map((fixture) => fixture.mirror)),
    ],
    [
      COLLECTIONS.audit,
      new MemoryCollection(fixtures.map((fixture) => fixture.audit)),
    ],
    [COLLECTIONS.hotel, new MemoryCollection([fixtures[0].hotel])],
    [BACKUP_COLLECTION, new MemoryCollection()],
    [MANIFEST_COLLECTION, new MemoryCollection()],
  ]);
  return {
    collection(name) {
      if (!collections.has(name)) collections.set(name, new MemoryCollection());
      return collections.get(name);
    },
    collections,
  };
}

function fixture(base) {
  const target = cloneBson(base);
  const dates = dateRange(target.checkinDate, target.checkoutDate);
  const parsedRoomName = "Triple Bed Room With Air Conditioning";
  const sourceRoomName = `${parsedRoomName} - Room Only - 3 Occupancy`;
  const bodyText = [
    `Booking ID ${target.otaBookingId} Reservation Information`,
    "PREPAID Booking confirmation",
    "Zad Ajyad",
    `Customer First Name SAFE Customer Last Name GUEST Country of Residence Saudi Arabia Check-in ${longDate(
      target.checkinDate
    )} Check-out ${longDate(target.checkoutDate)} Other Guests [RmNo.1]`,
    `Room Type No. of Rooms Occupancy No. of Extra Bed ${parsedRoomName} 1 2 Adults 0`,
    `From - To Rates ${dates
      .map(
        (date, index) =>
          `${longDate(date)} SAR ${target.daily[index].payout.toFixed(2)}`
      )
      .join(" ")} Reference sell rate (incl. taxes & fees) SAR ${target.grossTotalSar.toFixed(
      2
    )} Compensation Commission SAR -${target.deductionComponentAmountsSar[0].toFixed(
      2
    )} Agoda Growth Program SAR -${target.deductionComponentAmountsSar[1].toFixed(
      2
    )} Tax on Commission SAR -${target.deductionComponentAmountsSar[2].toFixed(
      2
    )} Targeted promotions`,
    `Net rate (incl. taxes & fees) SAR ${target.payoutTotalSar.toFixed(2)}`,
  ].join("\n");
  const room = {
    room_type: "tripleRooms",
    displayName: "Triple Room - Premium Comfort",
    sourceRoomName,
    hotelRoomConfigId: new ObjectId(target.roomConfigId),
    localRoomConfigId: new ObjectId(target.roomConfigId),
    count: 1,
    chosenPrice: round2(target.grossTotalSar / dates.length),
    totalPriceWithCommission: target.grossTotalSar,
    hotelShouldGet: target.rootTotalSar,
    pricingByDay: dates.map((date, index) => ({
      date,
      price: target.daily[index].client,
      clientPrice: target.daily[index].client,
      mainPrice: target.daily[index].client,
      rootPrice: target.daily[index].root,
      totalPriceWithCommission: target.daily[index].client,
      totalPriceWithoutCommission: target.daily[index].root,
      netAfterExpenses: target.daily[index].payout,
      netAfterOtaExpenses: target.daily[index].payout,
      otaExpenseAmount: target.daily[index].expense,
      platformMargin: target.daily[index].margin,
      commercialVerification: "unverified",
      hotelRunnerSourcePrice: null,
    })),
  };
  const paymentDetails = { captured: false, onsite_paid_amount: 0 };
  const paidBreakdown = {
    paid_online_via_link: 0,
    paid_at_hotel_cash: 0,
    paid_at_hotel_card: 0,
    paid_to_hotel: 0,
    paid_online_jannatbooking: 0,
    paid_online_other_platforms: target.grossTotalSar,
    paid_online_via_instapay: 0,
    paid_no_show: 0,
    payment_comments: "Agoda collected by platform",
  };
  const financialCycle = {
    collectionModel: "pms_collected",
    status: "open",
    commissionType: "amount",
    commissionValue: 0,
    commissionAmount: 0,
    commissionAssigned: false,
    commissionAssignedAt: null,
    commissionAssignedBy: null,
    pmsCollectedAmount: target.grossTotalSar,
    hotelCollectedAmount: 0,
    hotelPayoutDue: target.rootTotalSar,
    commissionDueToPms: 0,
    closedAt: null,
    closedBy: null,
    notes: "",
    lastUpdatedAt: new Date("2026-08-09T05:00:00.000Z"),
    lastUpdatedBy: null,
  };
  const reservation = {
    _id: new ObjectId(target.reservationMongoId),
    __v: target.reservationVersion,
    createdAt: new Date("2026-08-09T04:00:00.000Z"),
    updatedAt: new Date("2026-08-09T05:00:00.000Z"),
    hotelId: new ObjectId(EXPECTED_HOTEL_ID),
    belongsTo: OWNER_ID,
    confirmation_number: target.pmsConfirmationNumber,
    reservation_id: target.otaBookingId,
    hr_number: target.hrNumber.toLowerCase(),
    otaIdentityKey: target.otaIdentityKey,
    otaCrossTransportIdentityKey: "",
    booking_source: "agoda",
    customer_details: {
      name: "Safe Test Guest",
      confirmation_number2: target.otaBookingId,
      booking_source: "Agoda",
    },
    state: "ota platform review",
    reservation_status: "ota platform review",
    checkin_date: new Date(`${target.checkinDate}T00:00:00.000Z`),
    checkout_date: new Date(`${target.checkoutDate}T00:00:00.000Z`),
    total_rooms: 1,
    total_guests: 2,
    adults: 2,
    children: 0,
    roomId: [],
    bedNumber: [],
    total_amount: target.grossTotalSar,
    sub_total: target.rootTotalSar,
    currency: "sar",
    commission: 0,
    commission_ota: null,
    financeStatus: "paid online",
    payment: "paid online",
    paid_amount: target.grossTotalSar,
    payment_details: paymentDetails,
    paid_amount_breakdown: paidBreakdown,
    financial_cycle: financialCycle,
    vcc_payment: { charged: false, processing: false, metadata: {} },
    bofa_payment: {
      secure_acceptance: { status: "not_started", currency: "USD" },
      vcc: { charged: false, processing: false },
    },
    braintree_payment: {},
    pickedRoomsType: [cloneBson(room)],
    pickedRoomsPricing: [cloneBson(room)],
    adminPricing: {
      mode: "ota_platform_sync",
      source: "ota_email_create",
      clientTotal: target.grossTotalSar,
      rootTotal: target.rootTotalSar,
      netAfterExpensesTotal: target.payoutTotalSar,
      otaExpenseTotal: target.otaExpenseTotalSar,
      platformMarginTotal: round2(target.payoutTotalSar - target.rootTotalSar),
      commissionAmount: null,
      commercialVerified: false,
    },
    ota_financial_summary: {
      show: true,
      source: "ota_email_create",
      clientTotal: target.grossTotalSar,
      hotelVisibleAmount: target.rootTotalSar,
      netAfterExpenses: target.payoutTotalSar,
      netAfterOtaExpenses: target.payoutTotalSar,
      otaExpenseTotal: target.otaExpenseTotalSar,
      commercialVerified: false,
    },
    adminPricingVisibility: {
      rootOnlyForHotelManagement: true,
      source: "ota_email_create",
      appliedAt: new Date("2026-08-09T04:00:00.000Z"),
      appliedBy: null,
    },
    otaPlatformReview: {
      status: "pending",
      source: "ota_email_create",
      inboundEmailId: target.inboundEmailId,
      provider: "agoda",
      confirmationNumber: target.otaBookingId,
    },
    pendingConfirmation: { status: "" },
    supplierData: {
      supplierName: "Agoda",
      suppliedBookingNo: target.otaBookingId,
      otaConfirmationNumber: target.otaBookingId,
      platformConfirmationNumber: target.otaBookingId,
      otaProvider: "agoda",
      otaAutomationPipeline: "hotelrunner-background-worker",
      otaSourceAuthority: 4,
      otaTotalPayoutSar: target.payoutTotalSar,
      otaExpenseTotalSar: target.otaExpenseTotalSar,
      otaCommissionSar: null,
      otaCommissionSourceBacked: false,
      otaPaymentSummary: {
        sourceCurrency: "SAR",
        sourceTotalGuestPaymentAmount: target.grossTotalSar,
        sourceTotalPayoutAmount: target.payoutTotalSar,
        totalGuestPaymentAmount: target.grossTotalSar,
        totalPayoutAmount: target.payoutTotalSar,
        currency: "SAR",
        exchangeRateToSar: 1,
        exchangeRateSource: "identity",
        amountConvertedAt: "2026-08-09T04:00:00.000Z",
      },
      hotelRunner: {
        transport: "hotelrunner_api",
        reservationId: target.hotelRunnerReservationId,
        hrNumber: target.hrNumber,
        providerNumber: target.otaBookingId,
      },
    },
    reservationAuditLog: [{ source: "create" }, { source: "payment" }],
    adminChangeLog: [],
  };
  const normalizedSnapshot = {
    messageUid: `message-${target.otaBookingId}`,
    hotelRunnerReservationId: target.hotelRunnerReservationId,
    hrNumber: target.hrNumber,
    providerNumber: target.otaBookingId,
    channel: "agodaycs5",
    state: "confirmed",
    requiresResponse: false,
    checkinDate: target.checkinDate,
    checkoutDate: target.checkoutDate,
    totalGuests: 2,
    totalRooms: 1,
    subTotalCents: Math.round(target.payoutTotalSar * 100),
    extrasTotalCents: 0,
    adjustmentsTotalCents: 0,
    itemTotalCents: Math.round(target.payoutTotalSar * 100),
    taxTotalCents: 0,
    totalCents: Math.round(target.payoutTotalSar * 100),
    currency: "SAR",
    rooms: [
      {
        index: 0,
        state: "confirmed",
        name: parsedRoomName,
        checkinDate: target.checkinDate,
        checkoutDate: target.checkoutDate,
        nights: dates.length,
        totalGuests: 2,
        adults: 2,
        children: 0,
        priceCents: Math.round(target.payoutTotalSar * 100),
        totalCents: Math.round(target.payoutTotalSar * 100),
        dailyPrices: target.daily.map((day) => ({
          date: day.date,
          priceCents: Math.round(day.hotelRunnerSource * 100),
          originalPriceCents: Math.round(day.hotelRunnerSource * 100),
          discountCents: 0,
          rateCode: "",
          version: "",
        })),
      },
    ],
    issues: [],
  };
  const event = {
    _id: new ObjectId(target.eventId),
    hotelId: new ObjectId(EXPECTED_HOTEL_ID),
    eventKey: `event-${target.otaBookingId}`,
    messageUid: normalizedSnapshot.messageUid,
    payloadHash: sha256(`raw-${target.otaBookingId}`),
    canonicalHash: sha256(`canonical-${target.otaBookingId}`),
    source: "push",
    hotelRunnerReservationId: target.hotelRunnerReservationId,
    hrNumber: target.hrNumber,
    providerNumber: target.otaBookingId,
    channel: "agodaycs5",
    state: "confirmed",
    payload: cloneBson(normalizedSnapshot),
    status: "attention",
    attempts: 1,
    integrityReason: "",
    integrityConflict: false,
    errorCode: "hotelrunner_commercial_evidence_stale",
    reservationMongoId: new ObjectId(target.reservationMongoId),
    mirrorId: new ObjectId(target.mirrorId),
    deliveryCount: 1,
  };
  const mirror = {
    _id: new ObjectId(target.mirrorId),
    hotelId: new ObjectId(EXPECTED_HOTEL_ID),
    hotelRunnerReservationId: target.hotelRunnerReservationId,
    hrNumber: target.hrNumber,
    providerNumber: target.otaBookingId,
    channel: "agodaycs5",
    state: "confirmed",
    observedCanonicalHash: event.canonicalHash,
    appliedCanonicalHash: event.canonicalHash,
    reservationMongoId: new ObjectId(target.reservationMongoId),
    identityConflict: false,
    projectionStatus: "updated",
    projectionVersion: 1,
    normalizedSnapshot: cloneBson(normalizedSnapshot),
  };
  const audit = {
    _id: new ObjectId(target.inboundEmailId),
    source: "sendgrid",
    provider: "agoda",
    intent: "new reservation",
    eventType: "new",
    confirmationNumber: target.otaBookingId,
    from: '"agoda.com" <no-reply@agoda.com>',
    to: "reservations@example.com",
    subject: `Agoda Booking ID ${target.otaBookingId} - CONFIRMED Hotel Country: Saudi Arabia Check-in ${longDate(
      target.checkinDate
    )} / Language_English`,
    messageId: `<${target.otaBookingId}@agoda.com>`,
    emailHash: sha256(`email-${target.otaBookingId}`),
    textHash: sha256(bodyText),
    duplicateOf: null,
    bodyText,
    bodyHtml: "",
    senderAuthentication: {
      authenticatedAligned: true,
      trustedProvider: "agoda",
      method: "dkim",
    },
    receivedAt: new Date("2026-08-09T04:00:05.000Z"),
    normalizedReservation: {
      source: { receivedAt: "2026-08-09T04:00:00.000Z" },
      paymentSummary: {
        amountConvertedAt: "2026-08-09T04:00:00.000Z",
      },
    },
  };
  const hotel = {
    _id: new ObjectId(EXPECTED_HOTEL_ID),
    hotelName: "zad ajyad",
    belongsTo: OWNER_ID,
    activateHotel: true,
    xHotelProActive: true,
    roomCountDetails: [
      {
        _id: new ObjectId(target.roomConfigId),
        displayName: room.displayName,
        roomType: room.room_type,
        activeRoom: true,
      },
    ],
  };

  target.sourceRoomNameHash = sha256(sourceRoomName);
  target.paymentDetailsHash = canonicalEjsonSha256(paymentDetails);
  target.paidBreakdownHash = canonicalEjsonSha256(paidBreakdown);
  target.financialCycleHash = canonicalEjsonSha256(financialCycle);
  target.eventPayloadHash = event.payloadHash;
  target.canonicalHash = event.canonicalHash;
  target.normalizedSnapshotHash = canonicalEjsonSha256(normalizedSnapshot);
  target.eventDocumentHash = canonicalEjsonSha256(event);
  target.mirrorDocumentHash = canonicalEjsonSha256(mirror);
  target.inboundBodyTextHash = sha256(bodyText);
  target.inboundEmailHash = audit.emailHash;
  target.inboundAuditDocumentHash = canonicalEjsonSha256(audit);
  const normalized = normalizedFromAudit(target, audit);
  const evidence = buildHotelRunnerEmailCommercialEvidence(normalized, {
    appliedAt: PLANNED_AT,
  });
  assert.ok(evidence, "fixture authenticated evidence");
  target.evidenceHash = evidence.evidenceHash;
  target.evidenceSourceTextHash = evidence.sourceTextHash;
  target.reservationDocumentHash = canonicalEjsonSha256(reservation);
  return { target, reservation, event, mirror, audit, hotel, evidence };
}

function fixtures() {
  const items = EXACT_TARGETS.map(fixture);
  items[0].hotel.roomCountDetails = [
    ...new Map(
      items
        .flatMap((item) => item.hotel.roomCountDetails)
        .map((room) => [id(room._id), room])
    ).values(),
  ];
  items[1].hotel = items[0].hotel;
  return items;
}

async function readyPlan(db, targets) {
  return loadPlan({
    db,
    releaseSha: RELEASE_SHA,
    execution: EXECUTION,
    plannedAt: PLANNED_AT,
    targets,
  });
}

function capability(plan, clock = () => new Date(PLANNED_AT.getTime() + 1_000)) {
  const proofDetails = parseProof(
    proofToken(plan),
    new Date(PLANNED_AT.getTime() + 1_000)
  );
  return createMutationCapability({
    plan,
    proofDetails,
    execution: EXECUTION,
    clock,
  });
}

test("production constants permanently scope exactly the two requested paid Agoda reservations", () => {
  assert.equal(EXACT_TARGETS.length, 2);
  assert.deepEqual(
    EXACT_TARGETS.map((target) => target.otaBookingId),
    ["687767359", "2039719171"]
  );
  assert.deepEqual(
    EXACT_TARGETS.map((target) => target.rootTotalSar),
    [75, 150]
  );
  assert.deepEqual(
    EXACT_TARGETS.map((target) => target.daily.map((day) => day.hotelRunnerSource)),
    [[47.64], [46.09, 46.09]]
  );
  assert.deepEqual([...REQUIRED_MATCH_FIELDS].sort(), [
    "customer_details.confirmation_number2",
    "otaIdentityKey",
    "reservation_id",
    "supplierData.otaConfirmationNumber",
    "supplierData.platformConfirmationNumber",
    "supplierData.suppliedBookingNo",
  ]);
  for (const target of EXACT_TARGETS) {
    for (const field of [
      "reservationDocumentHash",
      "eventDocumentHash",
      "eventPayloadHash",
      "canonicalHash",
      "normalizedSnapshotHash",
      "mirrorDocumentHash",
      "inboundAuditDocumentHash",
      "inboundBodyTextHash",
      "inboundEmailHash",
      "evidenceHash",
      "evidenceSourceTextHash",
      "paymentDetailsHash",
      "paidBreakdownHash",
      "financialCycleHash",
    ]) {
      assert.match(target[field], /^[a-f0-9]{64}$/, `${target.key}.${field}`);
    }
    assert.equal(
      round2(target.grossTotalSar - target.payoutTotalSar),
      target.otaExpenseTotalSar
    );
    assert.equal(
      round2(
        target.deductionComponentAmountsSar.reduce(
          (sum, amount) => sum + amount,
          0
        ) + target.unclassifiedDeductionSar
      ),
      target.otaExpenseTotalSar
    );
    assert.equal(
      round2(target.daily.reduce((sum, day) => sum + day.client, 0)),
      target.grossTotalSar
    );
    assert.equal(
      round2(target.daily.reduce((sum, day) => sum + day.payout, 0)),
      target.payoutTotalSar
    );
  }
});

test("arguments and proof require exact release, repair id, and a fresh dry run", () => {
  assert.deepEqual(parseArguments([`--release-sha=${RELEASE_SHA}`]), {
    apply: false,
    repairId: "",
    releaseSha: RELEASE_SHA,
    proof: "",
  });
  assert.throws(() => parseArguments([]), /release-sha/);
  assert.throws(
    () =>
      parseArguments([
        "--apply",
        `--release-sha=${RELEASE_SHA}`,
        `--repair-id=${REPAIR_ID}`,
      ]),
    /dry-run proof/
  );
  const token = `${PLANNED_AT.getTime()}.${"d".repeat(64)}`;
  assert.equal(
    parseProof(token, new Date(PLANNED_AT.getTime() + 1_000)).planHash,
    "d".repeat(64)
  );
  assert.throws(
    () =>
      parseProof(
        token,
        new Date(PLANNED_AT.getTime() + PROOF_MAX_AGE_MS + 1)
      ),
    /expired/
  );
});

test("exact authenticated SAR evidence and mirror nights produce only approved commercial changes", async () => {
  const items = fixtures();
  const db = memoryDb(items);
  const targets = items.map((item) => item.target);
  const plan = await readyPlan(db, targets);
  assert.equal(plan.state, "ready");
  assert.equal(plan.scopes.length, 2);
  for (const scope of plan.scopes) {
    assert.equal(scope.evidence.verified, true);
    assert.equal(scope.evidence.currency, "SAR");
    assert.equal(scope.normalized.paymentSummary.exchangeRateToSar, 1);
    assert.equal(scope.normalized.paymentSummary.exchangeRateSource, "identity");
    assert.deepEqual(commercialRows(scope.expectedDocument), scope.target.daily);
    assert.equal(
      canonicalEjsonSha256(paymentSettlementSnapshot(scope.originalDocument)),
      canonicalEjsonSha256(paymentSettlementSnapshot(scope.expectedDocument))
    );
    assert.equal(
      canonicalEjsonSha256(rootBaseSnapshot(scope.originalDocument)),
      canonicalEjsonSha256(rootBaseSnapshot(scope.expectedDocument))
    );
    assert.equal(
      canonicalEjsonSha256(immutableRemainder(scope.originalDocument)),
      canonicalEjsonSha256(immutableRemainder(scope.expectedDocument))
    );
  }
});

test("mirror seeding never falls back to the legacy Agoda gross as HotelRunner source", () => {
  const item = fixtures()[0];
  const rows = item.target.daily.map((day) => ({
    date: day.date,
    amount: day.hotelRunnerSource,
  }));
  const seeded = seedMirrorSourcePrices(item.target, item.reservation, rows);
  const source = seeded.pickedRoomsPricing[0].pricingByDay[0];
  assert.equal(source.clientPrice, 77);
  assert.equal(source.hotelRunnerSourcePrice, 47.64);
  assert.notEqual(source.hotelRunnerSourcePrice, source.clientPrice);
});

test("permanent backup contains eight full BSON/EJSON documents and a bound manifest hash", async () => {
  const items = fixtures();
  const db = memoryDb(items);
  const plan = await readyPlan(db, items.map((item) => item.target));
  const records = buildBackupRecords(plan);
  assert.equal(records.length, 8);
  for (const record of records) {
    assert.equal(
      canonicalEjson(record.originalDocument),
      record.originalEjson
    );
    assert.equal(
      canonicalEjsonSha256(record.originalDocument),
      record.originalHash
    );
  }
  const verified = verifyBackupRecords(records, null, plan.targets);
  const manifest = buildManifest(plan, records);
  assert.equal(manifest.backupSetSha256, verified.backupSetSha256);
  assert.match(manifest.manifestHash, /^[a-f0-9]{64}$/);
  const tampered = records.map(cloneBson);
  tampered[0].originalDocument.total_amount += 1;
  assert.throws(
    () => verifyBackupRecords(tampered, null, plan.targets),
    /integrity failed/
  );
});

test("ready plans cannot cross the write boundary without the bound proof capability", async () => {
  const items = fixtures();
  const db = memoryDb(items);
  const plan = await readyPlan(db, items.map((item) => item.target));
  await assert.rejects(
    () => applyRepairPlan({ db, plan, capability: null }),
    (error) => error?.code === "AGODA_PAID_WRITE_UNAUTHORIZED"
  );
  assert.equal(db.collection(BACKUP_COLLECTION).documents.length, 0);
  assert.equal(db.collection(MANIFEST_COLLECTION).documents.length, 0);
  assert.equal(db.collection(COLLECTIONS.reservation).replaceCalls, 0);
});

test("standalone apply backs up first, repairs exactly two by CAS, preserves evidence, and is idempotent", async () => {
  const items = fixtures();
  const db = memoryDb(items);
  const targets = items.map((item) => item.target);
  const evidenceBefore = canonicalEjsonSha256({
    events: db.collection(COLLECTIONS.event).documents,
    mirrors: db.collection(COLLECTIONS.mirror).documents,
    audits: db.collection(COLLECTIONS.audit).documents,
  });
  const plan = await readyPlan(db, targets);
  const result = await applyRepairPlan({
    db,
    plan,
    capability: capability(plan),
  });
  assert.equal(result.state, "applied");
  assert.equal(result.changed, 2);
  assert.equal(db.collection(BACKUP_COLLECTION).documents.length, 8);
  assert.equal(
    db.collection(MANIFEST_COLLECTION).documents[0].state,
    "applied"
  );
  assert.equal(
    canonicalEjsonSha256({
      events: db.collection(COLLECTIONS.event).documents,
      mirrors: db.collection(COLLECTIONS.mirror).documents,
      audits: db.collection(COLLECTIONS.audit).documents,
    }),
    evidenceBefore
  );
  const observed = await loadPlan({
    db,
    releaseSha: RELEASE_SHA,
    execution: EXECUTION,
    plannedAt: new Date(PLANNED_AT.getTime() + 5_000),
    targets,
  });
  assert.equal(observed.state, "already_applied");
  const idempotent = await applyRepairPlan({ db, plan: observed });
  assert.equal(idempotent.state, "already_applied");
  assert.equal(idempotent.changed, 0);
});

test("lost acknowledgement is resolved by exact hash readback without a write retry", async () => {
  const items = fixtures();
  const db = memoryDb(items, {
    replaceHook: ({ call, commit }) => {
      const result = commit();
      if (call === 1) throw new Error("simulated lost acknowledgement");
      return result;
    },
  });
  const plan = await readyPlan(db, items.map((item) => item.target));
  const result = await applyRepairPlan({
    db,
    plan,
    capability: capability(plan),
  });
  assert.equal(result.state, "applied");
  assert.equal(result.acknowledgementsRecovered, 1);
  assert.equal(db.collection(COLLECTIONS.reservation).replaceCalls, 2);
});

test("second reservation CAS failure reverses the first from exact expected to exact original", async () => {
  const items = fixtures();
  const originalHash = canonicalEjsonSha256(
    items.map((item) => item.reservation)
  );
  const db = memoryDb(items, {
    replaceHook: ({ call, commit }) =>
      call === 2
        ? { acknowledged: true, matchedCount: 0, modifiedCount: 0 }
        : commit(),
  });
  const plan = await readyPlan(db, items.map((item) => item.target));
  await assert.rejects(
    () =>
      applyRepairPlan({
        db,
        plan,
        capability: capability(plan),
      }),
    (error) => error?.code === "AGODA_PAID_REPAIR_COMPENSATED"
  );
  assert.equal(
    canonicalEjsonSha256(db.collection(COLLECTIONS.reservation).documents),
    originalHash
  );
  assert.equal(
    db.collection(MANIFEST_COLLECTION).documents[0].state,
    "backed_up"
  );
});

test("duplicate identity and mirror-source drift fail before backup or reservation mutation", async () => {
  const items = fixtures();
  const duplicate = cloneBson(items[0].reservation);
  duplicate._id = new ObjectId("6a77f6d27735a50431e27799");
  const duplicateDb = memoryDb(items, { duplicateReservation: duplicate });
  await assert.rejects(
    () => readyPlan(duplicateDb, items.map((item) => item.target)),
    /exactly one document/
  );
  assert.equal(duplicateDb.collection(BACKUP_COLLECTION).documents.length, 0);

  const driftedItems = fixtures();
  driftedItems[0].mirror.normalizedSnapshot.rooms[0].dailyPrices[0].priceCents =
    7700;
  driftedItems[0].target.mirrorDocumentHash = canonicalEjsonSha256(
    driftedItems[0].mirror
  );
  driftedItems[0].target.normalizedSnapshotHash = canonicalEjsonSha256(
    driftedItems[0].mirror.normalizedSnapshot
  );
  driftedItems[0].event.payload = cloneBson(
    driftedItems[0].mirror.normalizedSnapshot
  );
  driftedItems[0].target.eventDocumentHash = canonicalEjsonSha256(
    driftedItems[0].event
  );
  const driftDb = memoryDb(driftedItems);
  await assert.rejects(
    () => readyPlan(driftDb, driftedItems.map((item) => item.target)),
    /mirror nightly payout changed/
  );
  assert.equal(driftDb.collection(BACKUP_COLLECTION).documents.length, 0);
});

test("incident script has no vendor client, reservation create, or shared-runtime target constants", () => {
  const source = fs.readFileSync(
    path.join(
      __dirname,
      "repairAgodaPaidCommercialMaterialization20260809.js"
    ),
    "utf8"
  );
  assert.doesNotMatch(
    source,
    /HotelRunnerClient|createHotelRunnerClient|axios|https\.request|fetch\s*\(/
  );
  assert.doesNotMatch(source, /Reservations\.create|reservations\.insertOne/);
  const mapper = fs.readFileSync(
    path.join(__dirname, "../services/otaReservationMapper.js"),
    "utf8"
  );
  assert.doesNotMatch(mapper, /687767359|2039719171/);
  assert.match(source, /buildFullDocumentCasFilter/);
});
