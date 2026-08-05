/** @format */

"use strict";

const assert = require("node:assert/strict");

const {
  buildExactCasFilter: buildShapeAwareCasFilter,
  canonicalEjsonSha256,
  canonicalEqual,
  cloneBson,
} = require("./tripHotelRunnerRepair20260805");

const buildStrictExactCasFilter = (document) => {
  const shapeAware = buildShapeAwareCasFilter(document);
  return {
    $and: [
      ...shapeAware.$and,
      ...Object.keys(document || {}).map((field) => ({
        [field]: { $exists: true },
      })),
    ],
  };
};

const OPERATION = "ota-pricing-save-incident-20260805";
const REPAIR_ACTION = "repair-ota-pricing-save-and-lifecycle";
const REPAIR_SOURCE = "ota-pricing-incident-repair";
const MANIFEST_COLLECTION = "ota_pricing_save_incident_manifests_20260805";
const BACKUP_COLLECTION_PREFIX = "ota_pricing_save_incident_backup_20260805_";

const TARGET = Object.freeze({
  mongoId: "6a735107b880d28d664f6039",
  pmsConfirmation: "8052012670",
  otaConfirmation: "686490863",
  hotelId: "6a40b6a1a6efe70450536038",
  checkin: "2026-08-16",
  checkout: "2026-08-27",
  nights: 11,
  totalRooms: 1,
  roomType: "doubleRooms",
  hotelRoomConfigId: "6a40df5f1a6d1850eb25c183",
  clientTotal: 768.35,
  rootTotal: 825,
  netTotal: 475.42,
  otaExpenseTotal: 292.93,
  platformMarginTotal: -349.58,
  intendedCommission: 82.5,
  version: 2,
  updatedAt: "2026-08-05T17:04:24.760Z",
  statusAuditAt: "2026-08-05T16:05:57.741Z",
  pricingAuditTimes: Object.freeze([
    "2026-08-05T17:03:23.370Z",
    "2026-08-05T17:04:24.754Z",
  ]),
});

const id = (value) => String(value?._id || value?.id || value || "").trim();
const dateKey = (value) => {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
};
const iso = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
};
const money = (value, label = "Money value") => {
  assert.notEqual(value, null, `${label} must be present.`);
  assert.notEqual(value, undefined, `${label} must be present.`);
  assert.ok(
    typeof value === "number" || typeof value === "string",
    `${label} must be numeric.`
  );
  if (typeof value === "string") {
    assert.notEqual(value.trim(), "", `${label} must be numeric.`);
  }
  const parsed = Number(value);
  assert.ok(
    Number.isFinite(parsed),
    `${label} must be a finite numeric value.`
  );
  return Number(parsed.toFixed(2));
};
const roomCount = (room = {}) => {
  const countField = ["count", "totalRooms", "total_rooms"].find((field) =>
    Object.prototype.hasOwnProperty.call(room || {}, field)
  );
  if (!countField) return 1;
  const value = room[countField];
  assert.notEqual(value, null, `Room ${countField} must be numeric.`);
  assert.notEqual(value, undefined, `Room ${countField} must be numeric.`);
  assert.ok(
    typeof value === "number" || typeof value === "string",
    `Room ${countField} must be numeric.`
  );
  if (typeof value === "string") {
    assert.notEqual(value.trim(), "", `Room ${countField} must be numeric.`);
  }
  const parsed = Number(value);
  assert.ok(
    Number.isInteger(parsed) && parsed > 0,
    "Room count must be a positive integer."
  );
  return parsed;
};

const firstMoney = (...values) => {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    return money(value, "Nightly pricing value");
  }
  return 0;
};

const summarizeRooms = (rooms = []) =>
  (Array.isArray(rooms) ? rooms : []).reduce(
    (totals, room) => {
      const count = roomCount(room);
      const days = Array.isArray(room?.pricingByDay) ? room.pricingByDay : [];
      totals.rooms += count;
      totals.days += days.length * count;
      for (const day of days) {
        totals.client +=
          firstMoney(
            day.clientPrice,
            day.mainPrice,
            day.totalPriceWithCommission,
            day.price
          ) * count;
        totals.root +=
          firstMoney(
            day.rootPrice,
            day.totalPriceWithoutCommission,
            day.basePrice
          ) * count;
        totals.net +=
          firstMoney(day.netAfterExpenses, day.netAfterOtaExpenses) * count;
        totals.otaExpense +=
          firstMoney(day.otaExpenseAmount, day.otaExpense) * count;
        totals.platformMargin += firstMoney(day.platformMargin) * count;
      }
      return totals;
    },
    {
      rooms: 0,
      days: 0,
      client: 0,
      root: 0,
      net: 0,
      otaExpense: 0,
      platformMargin: 0,
    }
  );

const assertMoney = (actual, expected, label) =>
  assert.equal(
    money(actual, label),
    money(expected, `${label} expectation`),
    `${label} changed.`
  );

const findAudit = (reservation, predicate, label) => {
  const matches = (
    Array.isArray(reservation?.reservationAuditLog)
      ? reservation.reservationAuditLog
      : []
  ).filter(predicate);
  assert.equal(matches.length, 1, `Expected exactly one ${label} audit.`);
  return matches[0];
};

const validateCurrentReservation = (reservation) => {
  assert.ok(reservation, "Target reservation was not found.");
  assert.equal(
    id(reservation._id),
    TARGET.mongoId,
    "Reservation Mongo ID changed."
  );
  assert.equal(
    String(reservation.confirmation_number || ""),
    TARGET.pmsConfirmation,
    "PMS confirmation changed."
  );
  assert.equal(
    String(reservation?.supplierData?.otaConfirmationNumber || ""),
    TARGET.otaConfirmation,
    "Supplier OTA confirmation changed."
  );
  assert.equal(
    String(reservation?.otaPlatformReview?.confirmationNumber || ""),
    TARGET.otaConfirmation,
    "OTA review confirmation changed."
  );
  assert.equal(
    String(reservation.booking_source || "").toLowerCase(),
    "agoda",
    "Booking source changed."
  );
  assert.equal(
    String(reservation?.supplierData?.otaProvider || "").toLowerCase(),
    "agoda",
    "Supplier OTA provider changed."
  );
  assert.equal(
    String(reservation?.otaPlatformReview?.provider || "").toLowerCase(),
    "agoda",
    "OTA review provider changed."
  );
  assert.equal(
    id(reservation.hotelId),
    TARGET.hotelId,
    "Assigned hotel changed."
  );
  assert.equal(
    dateKey(reservation.checkin_date),
    TARGET.checkin,
    "Check-in changed."
  );
  assert.equal(
    dateKey(reservation.checkout_date),
    TARGET.checkout,
    "Checkout changed."
  );
  assert.equal(
    reservation.days_of_residence,
    TARGET.nights,
    "Night count changed."
  );
  assert.equal(
    reservation.total_rooms,
    TARGET.totalRooms,
    "Total room count changed."
  );
  assert.equal(reservation.__v, TARGET.version, "Reservation version changed.");
  assert.equal(
    iso(reservation.updatedAt),
    TARGET.updatedAt,
    "Reservation update time changed."
  );
  assert.equal(
    String(reservation.reservation_status || "").toLowerCase(),
    "confirmed",
    "The incident lifecycle status is no longer the expected confirmed value."
  );
  assert.equal(
    String(reservation.state || "").toLowerCase(),
    "confirmed",
    "The incident lifecycle state is no longer the expected confirmed value."
  );
  assert.equal(
    String(reservation?.otaPlatformReview?.status || "").toLowerCase(),
    "pending",
    "OTA review marker is no longer pending."
  );
  assert.equal(
    reservation?.otaPlatformReview?.releasedAt,
    null,
    "Reservation has since been released; automatic repair is blocked."
  );
  assert.equal(
    reservation?.otaPlatformReview?.releasedBy,
    null,
    "Reservation has since been released by an operator; automatic repair is blocked."
  );

  assertMoney(reservation.total_amount, TARGET.clientTotal, "Client total");
  assertMoney(reservation.sub_total, TARGET.rootTotal, "Hotel root total");
  assertMoney(
    reservation?.adminPricing?.clientTotal,
    TARGET.clientTotal,
    "Admin client total"
  );
  assertMoney(
    reservation?.adminPricing?.rootTotal,
    TARGET.rootTotal,
    "Admin root total"
  );
  assertMoney(
    reservation?.adminPricing?.netAfterExpensesTotal,
    TARGET.netTotal,
    "Admin net total"
  );
  assertMoney(
    reservation?.adminPricing?.otaExpenseTotal,
    TARGET.otaExpenseTotal,
    "Admin OTA expense total"
  );
  assertMoney(
    reservation?.adminPricing?.platformMarginTotal,
    TARGET.platformMarginTotal,
    "Admin platform margin total"
  );
  assertMoney(reservation.commission, 0, "Top-level incident commission");
  assertMoney(
    reservation?.adminPricing?.commissionAmount,
    0,
    "Admin incident commission"
  );
  assertMoney(
    reservation?.financial_cycle?.commissionAmount,
    0,
    "Financial-cycle incident commission"
  );
  assertMoney(
    reservation?.financial_cycle?.commissionValue,
    0,
    "Financial-cycle incident commission value"
  );
  assert.equal(
    String(reservation?.financial_cycle?.commissionType || "").toLowerCase(),
    "amount",
    "Financial-cycle commission type changed."
  );

  const typeRooms = Array.isArray(reservation.pickedRoomsType)
    ? reservation.pickedRoomsType
    : [];
  const pricingRooms = Array.isArray(reservation.pickedRoomsPricing)
    ? reservation.pickedRoomsPricing
    : [];
  assert.ok(typeRooms.length > 0, "Target pickedRoomsType is empty.");
  assert.ok(pricingRooms.length > 0, "Target pickedRoomsPricing is empty.");
  assert.equal(typeRooms.length, 1, "Target room-type entry count changed.");
  assert.equal(
    pricingRooms.length,
    1,
    "Target pricing-room entry count changed."
  );
  assert.ok(
    canonicalEqual(typeRooms, pricingRooms),
    "The two pricing arrays diverged after the incident; automatic repair is blocked."
  );
  assert.equal(
    String(pricingRooms[0]?.room_type || ""),
    TARGET.roomType,
    "Target room type changed."
  );
  assert.equal(
    id(pricingRooms[0]?.hotelRoomConfigId),
    TARGET.hotelRoomConfigId,
    "Target hotel room configuration changed."
  );
  assert.ok(
    Object.prototype.hasOwnProperty.call(pricingRooms[0], "count"),
    "Target room count field is missing."
  );
  assert.equal(pricingRooms[0].count, 1, "Target room count changed.");
  assert.equal(roomCount(pricingRooms[0]), 1, "Booked room quantity changed.");
  assert.ok(
    Array.isArray(pricingRooms[0]?.pricingByDay),
    "Target nightly pricing array is missing."
  );
  const expectedPricingDates = Array.from(
    { length: TARGET.nights },
    (_, index) => {
      const date = new Date(`${TARGET.checkin}T00:00:00.000Z`);
      date.setUTCDate(date.getUTCDate() + index);
      return date.toISOString().slice(0, 10);
    }
  );
  assert.deepEqual(
    pricingRooms[0].pricingByDay.map((day) => dateKey(day?.date)),
    expectedPricingDates,
    "Nightly pricing dates changed or are no longer contiguous."
  );
  const totals = summarizeRooms(pricingRooms);
  assert.equal(totals.rooms, 1, "Booked room quantity changed.");
  assert.equal(totals.days, TARGET.nights, "Nightly pricing coverage changed.");
  assertMoney(totals.client, TARGET.clientTotal, "Nightly client total");
  assertMoney(totals.root, TARGET.rootTotal, "Nightly hotel root total");
  assertMoney(totals.net, TARGET.netTotal, "Nightly net total");
  assertMoney(
    totals.otaExpense,
    TARGET.otaExpenseTotal,
    "Nightly OTA expense total"
  );
  assertMoney(
    totals.platformMargin,
    TARGET.platformMarginTotal,
    "Nightly platform margin total"
  );

  const statusAudit = findAudit(
    reservation,
    (entry) =>
      entry?.action === "reservation_update" &&
      entry?.field === "reservation_status" &&
      iso(entry.at) === TARGET.statusAuditAt &&
      String(entry.from || "").toLowerCase() === "ota platform review" &&
      String(entry.to || "").toLowerCase() === "confirmed",
    "incident status"
  );
  const pendingAudit = findAudit(
    reservation,
    (entry) =>
      entry?.action === "reservation_update" &&
      entry?.field === "pendingConfirmation" &&
      iso(entry.at) === TARGET.statusAuditAt,
    "incident pending-confirmation"
  );
  const decisionAudit = findAudit(
    reservation,
    (entry) =>
      entry?.action === "reservation_update" &&
      entry?.field === "agentDecisionSnapshot" &&
      iso(entry.at) === TARGET.statusAuditAt,
    "incident agent-decision"
  );
  const pricingAudits = TARGET.pricingAuditTimes.map((auditAt, index) =>
    findAudit(
      reservation,
      (entry) =>
        entry?.action === "pricing-updated-before-release" &&
        iso(entry.at) === auditAt &&
        money(entry?.to?.commission) === 0,
      `incident pricing save ${index + 1}`
    )
  );
  assertMoney(
    pricingAudits[0]?.from?.commission,
    165,
    "Original commission evidence"
  );
  assertMoney(
    pricingAudits[1]?.from?.commission,
    0,
    "Second-save commission evidence"
  );

  const assertLifecycleSnapshot = (snapshot, label) => {
    assert.ok(
      snapshot && typeof snapshot === "object" && !Array.isArray(snapshot),
      `${label} pre-incident snapshot must be an object.`
    );
    assert.equal(
      String(snapshot.status || "").trim(),
      "",
      `${label} status changed.`
    );
  };
  assertLifecycleSnapshot(pendingAudit.from, "Pending-confirmation");
  assert.equal(
    String(pendingAudit.from.rejectionReason || ""),
    "",
    "Pending-confirmation rejection reason changed."
  );
  assert.equal(
    String(pendingAudit.from.confirmationReason || ""),
    "",
    "Pending-confirmation confirmation reason changed."
  );
  for (const field of [
    "confirmedAt",
    "rejectedAt",
    "lastUpdatedAt",
    "lastUpdatedBy",
  ]) {
    assert.equal(
      pendingAudit.from[field],
      null,
      `Pending-confirmation ${field} changed.`
    );
  }
  assertLifecycleSnapshot(decisionAudit.from, "Agent-decision");
  assert.equal(
    String(decisionAudit.from.reason || ""),
    "",
    "Agent-decision reason changed."
  );
  for (const field of ["decidedAt", "decidedBy"]) {
    assert.equal(
      decisionAudit.from[field],
      null,
      `Agent-decision ${field} changed.`
    );
  }

  return { statusAudit, pendingAudit, decisionAudit, pricingAudits, totals };
};

const validateRepairId = (value) => {
  const repairId = String(value || "").trim();
  assert.match(
    repairId,
    /^[A-Za-z0-9][A-Za-z0-9._-]{7,99}$/,
    "Repair ID must be 8-100 safe characters."
  );
  return repairId;
};

const buildBackupCollectionName = (repairId) =>
  `${BACKUP_COLLECTION_PREFIX}${validateRepairId(repairId).replace(
    /[^A-Za-z0-9_-]/g,
    "_"
  )}`;

const allowedChangedTopLevelFields = Object.freeze([
  "__v",
  "adminPricing",
  "agentDecisionSnapshot",
  "commission",
  "financial_cycle",
  "pendingConfirmation",
  "reservationAuditLog",
  "reservation_status",
  "state",
  "updatedAt",
]);

const assertUnrelatedTopLevelFieldsPreserved = (before, after) => {
  const left = cloneBson(before);
  const right = cloneBson(after);
  for (const field of allowedChangedTopLevelFields) {
    delete left[field];
    delete right[field];
  }
  assert.ok(
    canonicalEqual(left, right),
    "The repair plan changed an unrelated top-level reservation field."
  );

  const assertNestedPreservedExcept = (
    beforeValue,
    afterValue,
    allowedFields,
    label
  ) => {
    const beforeNested = cloneBson(beforeValue || {});
    const afterNested = cloneBson(afterValue || {});
    for (const field of allowedFields) {
      delete beforeNested[field];
      delete afterNested[field];
    }
    assert.ok(
      canonicalEqual(beforeNested, afterNested),
      `The repair plan changed an unrelated ${label} field.`
    );
  };

  assertNestedPreservedExcept(
    before.adminPricing,
    after.adminPricing,
    ["commissionAmount"],
    "adminPricing"
  );
  assertNestedPreservedExcept(
    before.financial_cycle,
    after.financial_cycle,
    ["commissionValue", "commissionAmount"],
    "financial_cycle"
  );

  const beforeAudit = Array.isArray(before.reservationAuditLog)
    ? before.reservationAuditLog
    : [];
  const afterAudit = Array.isArray(after.reservationAuditLog)
    ? after.reservationAuditLog
    : [];
  assert.equal(
    afterAudit.length,
    beforeAudit.length + 1,
    "Repair must append exactly one audit entry."
  );
  assert.ok(
    canonicalEqual(afterAudit.slice(0, beforeAudit.length), beforeAudit),
    "Repair changed existing audit history."
  );
};

const buildExpectedDocument = ({ reservation, context }) => {
  const evidence = validateCurrentReservation(reservation);
  const after = cloneBson(reservation);
  const repairAt = new Date(context.repairAt);
  assert.ok(!Number.isNaN(repairAt.getTime()), "Repair timestamp is invalid.");
  assert.ok(
    repairAt.getTime() > new Date(TARGET.updatedAt).getTime(),
    "Repair timestamp must be later than the exact incident document timestamp."
  );
  const repairId = validateRepairId(context.repairId);
  assert.equal(
    String(context.backupCollection || ""),
    buildBackupCollectionName(repairId),
    "Backup collection does not match repair ID."
  );

  after.reservation_status = "OTA Platform Review";
  after.state = "OTA Platform Review";
  after.pendingConfirmation = cloneBson(evidence.pendingAudit.from || {});
  after.agentDecisionSnapshot = cloneBson(evidence.decisionAudit.from || {});
  after.commission = TARGET.intendedCommission;
  after.adminPricing = {
    ...(after.adminPricing || {}),
    commissionAmount: TARGET.intendedCommission,
  };
  after.financial_cycle = {
    ...(after.financial_cycle || {}),
    commissionValue: TARGET.intendedCommission,
    commissionAmount: TARGET.intendedCommission,
  };
  after.reservationAuditLog = [
    ...(Array.isArray(after.reservationAuditLog)
      ? after.reservationAuditLog
      : []),
    {
      at: repairAt,
      source: REPAIR_SOURCE,
      action: REPAIR_ACTION,
      repairId,
      backupCollection: context.backupCollection,
      reasonCodes: [
        "ota_pricing_commission_silently_zeroed",
        "ota_review_lifecycle_status_inconsistent",
      ],
      evidence: {
        userProvidedScreenshotCommission: TARGET.intendedCommission,
        pricingAuditTimes: [...TARGET.pricingAuditTimes],
        statusAuditAt: TARGET.statusAuditAt,
      },
      from: {
        reservation_status: reservation.reservation_status,
        state: reservation.state,
        commission: money(reservation.commission),
      },
      to: {
        reservation_status: after.reservation_status,
        state: after.state,
        commission: TARGET.intendedCommission,
      },
    },
  ];
  after.updatedAt = repairAt;
  after.__v = Number(reservation.__v || 0) + 1;

  assertUnrelatedTopLevelFieldsPreserved(reservation, after);
  assert.ok(
    canonicalEqual(after.pickedRoomsType, reservation.pickedRoomsType),
    "Repair changed pickedRoomsType."
  );
  assert.ok(
    canonicalEqual(after.pickedRoomsPricing, reservation.pickedRoomsPricing),
    "Repair changed pickedRoomsPricing."
  );
  assertMoney(
    after.commission,
    TARGET.intendedCommission,
    "Repaired commission"
  );
  assertMoney(
    after.adminPricing?.commissionAmount,
    TARGET.intendedCommission,
    "Repaired admin commission"
  );
  assertMoney(
    after.financial_cycle?.commissionAmount,
    TARGET.intendedCommission,
    "Repaired financial-cycle commission"
  );
  assert.equal(after.reservation_status, "OTA Platform Review");
  assert.equal(after.state, "OTA Platform Review");
  assert.ok(
    canonicalEqual(after.otaPlatformReview, reservation.otaPlatformReview),
    "Repair changed the OTA review marker."
  );
  return after;
};

const buildRepairPlan = ({ reservation, context }) => {
  const expectedDocument = buildExpectedDocument({ reservation, context });
  const casFilter = buildStrictExactCasFilter(reservation);
  return {
    originalDocument: cloneBson(reservation),
    expectedDocument,
    originalHash: canonicalEjsonSha256(reservation),
    expectedHash: canonicalEjsonSha256(expectedDocument),
    casFilter,
    casFilterHash: canonicalEjsonSha256(casFilter),
    diff: {
      reservationStatus: {
        from: reservation.reservation_status,
        to: expectedDocument.reservation_status,
      },
      state: { from: reservation.state, to: expectedDocument.state },
      commission: {
        from: money(reservation.commission),
        to: TARGET.intendedCommission,
      },
    },
  };
};

const verifyRepairedDocument = ({ before, after, context }) => {
  const expected = buildExpectedDocument({ reservation: before, context });
  assert.ok(
    canonicalEqual(after, expected),
    "Saved reservation differs from repair plan."
  );
  return true;
};

module.exports = {
  BACKUP_COLLECTION_PREFIX,
  MANIFEST_COLLECTION,
  OPERATION,
  REPAIR_ACTION,
  REPAIR_SOURCE,
  TARGET,
  buildBackupCollectionName,
  buildExpectedDocument,
  buildRepairPlan,
  buildStrictExactCasFilter,
  id,
  summarizeRooms,
  validateCurrentReservation,
  validateRepairId,
  verifyRepairedDocument,
};
