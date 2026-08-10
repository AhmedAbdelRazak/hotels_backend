"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const mongoose = require("mongoose");

const Reservations = require("../models/reservations");
const Rooms = require("../models/rooms");
const {
  ADMIN_RESERVATION_LIST_PROJECTION,
} = require("../services/adminReservationListProjection");
const {
  buildAuthenticatedProviderCommercialEvidence,
} = require("../services/otaCommercialEvidence");
const { paginatedReservationList } = require("../controllers/janat");

const HOTEL_A = new mongoose.Types.ObjectId("64a000000000000000000001");
const HOTEL_B = new mongoose.Types.ObjectId("64b000000000000000000002");
const OWNER_A = new mongoose.Types.ObjectId("64c000000000000000000003");
const ADMIN_ID = new mongoose.Types.ObjectId("64d000000000000000000004");

const clone = (value) => {
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof mongoose.Types.ObjectId) {
    return new mongoose.Types.ObjectId(String(value));
  }
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, clone(nested)])
    );
  }
  return value;
};

const deletePath = (target, path) => {
  const parts = path.split(".");
  const last = parts.pop();
  let cursor = target;
  for (const part of parts) {
    if (!cursor || typeof cursor !== "object") return;
    cursor = cursor[part];
  }
  if (cursor && typeof cursor === "object") delete cursor[last];
};

const applyProjection = (documents, projection) =>
  documents.map((document) => {
    const projected = clone(document);
    for (const [path, include] of Object.entries(projection || {})) {
      if (include === 0) deletePath(projected, path);
    }
    return projected;
  });

const now = new Date();
const yesterday = new Date(now);
yesterday.setDate(now.getDate() - 1);

const baseReservation = ({
  id,
  hotelId,
  hotelName,
  confirmation,
  name,
  status = "confirmed",
  payment = "not paid",
  createdAt = now,
}) => ({
  _id: new mongoose.Types.ObjectId(id),
  confirmation_number: confirmation,
  reservation_id: `reservation-${confirmation}`,
  booking_source: "direct",
  reservation_status: status,
  state: status,
  payment,
  createdAt,
  updatedAt: createdAt,
  checkin_date: now,
  checkout_date: new Date(now.getTime() + 24 * 60 * 60 * 1000),
  days_of_residence: 1,
  total_rooms: 1,
  total_amount: 1200,
  paid_amount: 0,
  commission: 100,
  roomId: [],
  belongsTo: {
    _id: OWNER_A,
    name: "Owner A",
    email: "owner@example.test",
    role: 2000,
  },
  hotelId: {
    _id: hotelId,
    hotelName,
    belongsTo: OWNER_A,
  },
  customer_details: {
    name,
    nickName: name.split(" ")[0],
    phone: "+15550000000",
    email: `${name.toLowerCase().replace(/\s/g, ".")}@example.test`,
    booking_source: "direct",
    reservedBy: "Admin One",
    confirmation_number2: `secondary-${confirmation}`,
  },
  payment_details: {
    captured: payment === "paid online",
    capturing: false,
    onsite_paid_amount: 0,
  },
  paid_amount_breakdown: {},
  paypal_details: {
    captured_total_sar: payment === "paid online" ? 1200 : 0,
    initial: {
      status: payment === "paid online" ? "COMPLETED" : "",
    },
    mit: [],
    captures: [],
  },
  vcc_payment: {
    charged: false,
    attempts: [{ request: "large diagnostic value".repeat(100) }],
  },
  braintree_payment: {
    attempts: [{ response: "large processor value".repeat(100) }],
  },
  bofa_payment: {
    secure_acceptance: {
      status: "not_started",
      callbacks: [{ payload: "callback".repeat(100) }],
      last_response_payload: { raw: "response".repeat(100) },
      outbound_metadata: { raw: "outbound".repeat(100) },
      request_context: { raw: "context".repeat(100) },
    },
    vcc: {
      charged: false,
      attempts: [{ response: "attempt".repeat(100) }],
    },
  },
  pickedRoomsType: [
    {
      room_type: "doubleRooms",
      count: 1,
      pricingByDay: [
        {
          rootPrice: 1000,
          commissionRate: 0.1,
          totalPriceWithoutCommission: 1100,
        },
      ],
    },
  ],
  adminPricing: {
    mode: "standard",
    clientTotal: 1200,
    rootTotal: 1000,
    platformMarginTotal: 200,
  },
  adminPricingVisibility: { rootOnlyForHotelManagement: false },
  reservationAuditLog: [
    {
      action: "reservation-updated",
      by: { _id: ADMIN_ID, role: 1000, name: "Admin" },
      before: { large: "before".repeat(100) },
      after: { large: "after".repeat(100) },
    },
  ],
  adminChangeLog: [
    {
      field: "commission",
      by: { _id: ADMIN_ID, role: 1000, name: "Admin" },
      from: 90,
      to: 100,
    },
  ],
});

const documents = [
  baseReservation({
    id: "65a000000000000000000001",
    hotelId: HOTEL_A,
    hotelName: "Hotel Alpha",
    confirmation: "alpha-1",
    name: "Alice Guest",
    payment: "paid online",
    createdAt: now,
  }),
  baseReservation({
    id: "65b000000000000000000002",
    hotelId: HOTEL_B,
    hotelName: "Hotel Beta",
    confirmation: "beta-2",
    name: "Bob Guest",
    status: "cancelled",
    createdAt: yesterday,
  }),
];

Object.assign(documents[1].payment_details, {
  bofaSaAccepted: true,
  bofaVccCharged: true,
  captured: true,
});
Object.assign(documents[1].bofa_payment.secure_acceptance, {
  status: "accepted",
  last_response_signature_valid: true,
  currency: "USD",
  last_reference_number: "merchant-reference-2",
});
Object.assign(documents[1].bofa_payment.vcc, {
  charged: true,
  charge_count: 1,
  total_captured_usd: 250,
  last_success_at: yesterday,
  last_capture: {
    amount_usd: 250,
    currency: "USD",
    decision: "ACCEPT",
    reason_code: "100",
    reference_number: "merchant-reference-2",
    transaction_id: "transaction-2",
  },
});

const makeResponse = () => ({
  statusCode: null,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
});

const runHandler = async ({
  honorProjection,
  query = {},
  profile = {},
  sourceDocuments = documents,
}) => {
  const originalReservationsFind = Reservations.find;
  const originalRoomsFind = Rooms.find;
  let capturedFilter = null;
  let capturedProjection = null;
  let loadedDocuments = null;

  Reservations.find = (filter) => {
    capturedFilter = filter;
    const chain = {
      sort() {
        return this;
      },
      select(projection) {
        capturedProjection = projection;
        return this;
      },
      populate() {
        return this;
      },
      lean() {
        loadedDocuments = honorProjection
          ? applyProjection(sourceDocuments, capturedProjection)
          : clone(sourceDocuments);
        return Promise.resolve(loadedDocuments);
      },
    };
    return chain;
  };

  Rooms.find = () => ({
    select() {
      return this;
    },
    lean() {
      return this;
    },
    exec() {
      return Promise.resolve([]);
    },
  });

  const req = {
    query: { page: "1", limit: "15", ...query },
    profile,
  };
  const res = makeResponse();

  try {
    await paginatedReservationList(req, res);
  } finally {
    Reservations.find = originalReservationsFind;
    Rooms.find = originalRoomsFind;
  }

  assert.equal(res.statusCode, 200);
  return {
    body: res.body,
    capturedFilter,
    capturedProjection,
    loadedDocuments,
  };
};

test("uses a strict exclusion projection for only non-response audit and diagnostic histories", () => {
  assert.deepEqual(ADMIN_RESERVATION_LIST_PROJECTION, {
    adminChangeLog: 0,
    reservationAuditLog: 0,
    "bofa_payment.secure_acceptance.callbacks": 0,
    "bofa_payment.secure_acceptance.last_response_payload": 0,
    "bofa_payment.secure_acceptance.outbound_metadata": 0,
    "bofa_payment.secure_acceptance.request_context": 0,
    "bofa_payment.vcc.attempts": 0,
    "braintree_payment.attempts": 0,
    "vcc_payment.attempts": 0,
  });
  assert.ok(
    Object.values(ADMIN_RESERVATION_LIST_PROJECTION).every(
      (value) => value === 0
    ),
    "projection must remain exclusion-only so new business fields are retained"
  );
});

test("projecting audit histories preserves exact admin rows, search, filters, and scorecards", async () => {
  const request = {
    query: {
      searchQuery: "alice",
      filterType: "captured",
      reservedBy: "Admin One",
      bookingSource: "direct",
    },
    profile: { _id: ADMIN_ID, role: 7000, roleDescription: "order taker" },
  };
  const legacy = await runHandler({ ...request, honorProjection: false });
  const projected = await runHandler({ ...request, honorProjection: true });

  assert.deepEqual(projected.body, legacy.body);
  assert.equal(projected.body.data.length, 1);
  assert.equal(projected.body.data[0].confirmation_number, "alpha-1");
  assert.equal(projected.body.scorecards.totalReservations, 1);
  assert.equal(projected.body.scorecards.capturedReservations, 1);
  assert.deepEqual(
    Object.keys(projected.body.data[0]).sort(),
    Object.keys(legacy.body.data[0]).sort()
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      projected.body.data[0],
      "reservationAuditLog"
    ),
    false
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      projected.body.data[0],
      "adminChangeLog"
    ),
    false
  );
});

test("audit histories are absent before formatting while role and OTA scopes remain in the Mongo filter", async () => {
  const result = await runHandler({
    honorProjection: true,
    profile: {
      _id: ADMIN_ID,
      role: 1000,
      roleDescription: "platform admin",
      hotelsToSupport: [HOTEL_A],
    },
  });

  assert.deepEqual(
    result.capturedProjection,
    ADMIN_RESERVATION_LIST_PROJECTION
  );
  for (const document of result.loadedDocuments) {
    assert.equal(document.reservationAuditLog, undefined);
    assert.equal(document.adminChangeLog, undefined);
    assert.equal(document.vcc_payment.attempts, undefined);
    assert.equal(document.braintree_payment.attempts, undefined);
    assert.equal(document.bofa_payment.vcc.attempts, undefined);
    assert.equal(
      document.bofa_payment.secure_acceptance.last_response_payload,
      undefined
    );
  }

  const serializedFilter = JSON.stringify(result.capturedFilter);
  assert.match(serializedFilter, /otaPlatformReview\.status/);
  assert.match(serializedFilter, /64a000000000000000000001/);
  assert.doesNotMatch(serializedFilter, /64b000000000000000000002/);
  assert.match(serializedFilter, /2025-05-01T00:00:00\.000Z/);
});

test("projection preserves super-admin and hotel-management visibility transformations", async () => {
  const visibilityDocuments = clone(documents);
  visibilityDocuments[0].booking_source = "AI Chat";
  visibilityDocuments[0].customer_details.booking_source = "AI Chat";
  visibilityDocuments[0].adminPricingVisibility = {
    rootOnlyForHotelManagement: true,
  };

  const profiles = [
    {
      _id: ADMIN_ID,
      role: 1000,
      roleDescription: "super admin",
      accessTo: ["AllReservations", "HotelsReservations"],
    },
    {
      _id: OWNER_A,
      role: 2000,
      roleDescription: "hotel management",
      __hotelManagementSourceView: true,
    },
  ];

  for (const profile of profiles) {
    const legacy = await runHandler({
      honorProjection: false,
      profile,
      sourceDocuments: visibilityDocuments,
    });
    const projected = await runHandler({
      honorProjection: true,
      profile,
      sourceDocuments: visibilityDocuments,
    });
    assert.deepEqual(projected.body, legacy.body);
    if (profile.__hotelManagementSourceView) {
      assert.equal(
        Object.hasOwn(projected.body.data[0], "gross_total_amount"),
        false
      );
      assert.equal(
        Object.hasOwn(projected.body.data[0], "net_total_amount"),
        false
      );
    }
  }
});

test("gateway diagnostic exclusions retain the verified VCC summary fields", async () => {
  const request = {
    query: { searchQuery: "beta-2" },
    profile: { _id: ADMIN_ID, role: 7000, roleDescription: "order taker" },
  };
  const legacy = await runHandler({ ...request, honorProjection: false });
  const projected = await runHandler({ ...request, honorProjection: true });

  assert.deepEqual(projected.body, legacy.body);
  assert.equal(projected.body.data.length, 1);
  assert.equal(
    projected.body.data[0].vcc_capture_summary.gateway,
    "Bank of America"
  );
  assert.equal(projected.body.data[0].vcc_capture_summary.amountUsd, 250);
});

test("compact admin rows retain verified OTA gross and net without exposing nested evidence", async () => {
  const otaReservation = baseReservation({
    id: "65c000000000000000000003",
    hotelId: HOTEL_A,
    hotelName: "Hotel Alpha",
    confirmation: "ota-verified-1",
    name: "Verified OTA Guest",
    createdAt: now,
  });
  otaReservation.booking_source = "agoda";
  otaReservation.customer_details.booking_source = "agoda";
  otaReservation.total_amount = 148.96;
  otaReservation.adminPricing = {
    mode: "hotelrunner_api",
    propertyCurrency: "SAR",
    clientTotal: 148.96,
    netAfterExpensesTotal: 92.18,
    otaExpenseTotal: 56.78,
    rootTotal: 150,
    commercialVerified: false,
  };
  otaReservation.supplierData = {
    otaProvider: "agoda",
    otaCommercialEvidenceStaleReason: "",
    hotelRunner: { transport: "hotelrunner_api" },
    otaCommercialEvidence: buildAuthenticatedProviderCommercialEvidence({
      provider: "agoda",
      authenticatedProvider: "agoda",
      sourceAuthenticated: true,
      sourceTrusted: true,
      sourceType: "authenticated_provider_portal",
      sourceCurrency: "SAR",
      propertyCurrency: "SAR",
      bookingBasis: "reservation_total",
      sourceHash: "a".repeat(64),
      sourceTimestamp: "2026-08-09T12:00:00.000Z",
      sourceId: "agoda-ota-verified-1",
      guestGross: { verified: true, amount: 148.96 },
      hotelPayout: { verified: true, amount: 92.18 },
    }),
  };

  const result = await runHandler({
    honorProjection: true,
    query: { searchQuery: "ota-verified-1" },
    profile: { _id: ADMIN_ID, role: 7000, roleDescription: "order taker" },
    sourceDocuments: [otaReservation],
  });

  assert.equal(result.body.data.length, 1);
  assert.equal(result.body.data[0].gross_total_amount, 148.96);
  assert.equal(result.body.data[0].net_total_amount, 92.18);
  assert.equal(result.body.data[0].financial_totals_currency, "SAR");
  assert.equal(result.body.data[0].gross_total_available, true);
  assert.equal(result.body.data[0].net_total_available, true);
  assert.equal(result.body.data[0].supplierData.otaCommercialEvidence, undefined);
});

test("compact admin rows reflect an already-saved OTA pricing breakdown", async () => {
  const otaReservation = baseReservation({
    id: "65e000000000000000000005",
    hotelId: HOTEL_A,
    hotelName: "Hotel Alpha",
    confirmation: "ota-saved-breakdown-1",
    name: "Saved Breakdown Guest",
    createdAt: now,
  });
  otaReservation.booking_source = "channel-partner";
  otaReservation.customer_details.booking_source = "channel-partner";
  otaReservation.currency = "sar";
  otaReservation.total_amount = 65.03;
  otaReservation.adminPricing = {
    mode: "ota_review",
    clientTotal: 65.03,
    rootTotal: 75,
    netAfterExpensesTotal: 52.02,
    otaExpenseTotal: 13.01,
    platformMarginTotal: -22.98,
  };
  otaReservation.adminPricingVisibility = {
    rootOnlyForHotelManagement: true,
  };
  otaReservation.ota_financial_summary = {
    currency: "SAR",
    clientTotal: 65.03,
    netAfterExpenses: 52.02,
    netAfterOtaExpenses: 52.02,
    otaExpenseTotal: 13.01,
  };
  otaReservation.supplierData = {
    hotelRunner: {
      transport: "hotelrunner_api",
      reservationId: "channel-reservation-1",
    },
  };

  const result = await runHandler({
    honorProjection: true,
    query: { searchQuery: "ota-saved-breakdown-1" },
    profile: { _id: ADMIN_ID, role: 1000, roleDescription: "super admin" },
    sourceDocuments: [otaReservation],
  });

  assert.equal(result.body.data.length, 1);
  assert.equal(result.body.data[0].gross_total_amount, 65.03);
  assert.equal(result.body.data[0].net_total_amount, 52.02);
  assert.equal(result.body.data[0].financial_totals_currency, "SAR");
  assert.equal(result.body.data[0].gross_total_available, true);
  assert.equal(result.body.data[0].net_total_available, true);
  assert.equal(result.body.data[0].adminPricing.clientTotal, 65.03);
  assert.equal(result.body.data[0].adminPricing.netAfterExpensesTotal, 52.02);
});

test("financial totals resolve from the persisted OTA summary before the display summary is derived", async () => {
  const otaReservation = baseReservation({
    id: "65d000000000000000000004",
    hotelId: HOTEL_A,
    hotelName: "Hotel Alpha",
    confirmation: "ota-summary-only-1",
    name: "Summary Only OTA Guest",
    createdAt: now,
  });
  otaReservation.booking_source = "agoda";
  otaReservation.customer_details.booking_source = "agoda";
  otaReservation.total_amount = 148.96;
  otaReservation.adminPricing = {
    mode: "hotelrunner_api",
    propertyCurrency: "SAR",
    clientTotal: 148.96,
    rootTotal: 150,
    commercialVerified: false,
  };
  otaReservation.ota_financial_summary = {
    propertyCurrency: "SAR",
    clientTotal: 148.96,
    netAfterExpenses: 92.18,
    otaExpenseTotal: 56.78,
    commercialVerified: true,
  };
  otaReservation.supplierData = {
    otaProvider: "agoda",
    otaCommercialEvidenceStaleReason: "",
    hotelRunner: { transport: "hotelrunner_api" },
    otaCommercialEvidence: buildAuthenticatedProviderCommercialEvidence({
      provider: "agoda",
      authenticatedProvider: "agoda",
      sourceAuthenticated: true,
      sourceTrusted: true,
      sourceType: "authenticated_provider_portal",
      sourceCurrency: "SAR",
      propertyCurrency: "SAR",
      bookingBasis: "reservation_total",
      sourceHash: "b".repeat(64),
      sourceTimestamp: "2026-08-09T12:00:00.000Z",
      sourceId: "agoda-ota-summary-only-1",
      guestGross: { verified: true, amount: 148.96 },
      hotelPayout: { verified: true, amount: 92.18 },
    }),
  };

  const result = await runHandler({
    honorProjection: true,
    query: { searchQuery: "ota-summary-only-1" },
    profile: { _id: ADMIN_ID, role: 7000, roleDescription: "order taker" },
    sourceDocuments: [otaReservation],
  });

  assert.equal(result.body.data.length, 1);
  assert.equal(result.body.data[0].gross_total_amount, 148.96);
  assert.equal(result.body.data[0].net_total_amount, 92.18);
  assert.equal(result.body.data[0].financial_totals_currency, "SAR");
  assert.equal(result.body.data[0].net_total_available, true);
  assert.equal(
    result.body.data[0].ota_financial_summary.netAfterExpenses,
    150,
    "the derived display summary intentionally differs from the persisted verified payout"
  );
});

test("the critical admin route retains its complete authentication and access middleware", () => {
  const routeSource = fs.readFileSync(
    path.join(__dirname, "..", "routes", "janat.js"),
    "utf8"
  );
  assert.match(
    routeSource,
    /"\/all-reservations-list-admin\/:userId",\s*requireSignin,\s*isAuth,\s*requireAdminAccess\("HotelsReservations", "AllReservations"\),\s*paginatedReservationList/s
  );
});
