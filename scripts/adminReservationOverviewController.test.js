const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const Reservations = require("../models/reservations");
const HotelDetails = require("../models/hotel_details");
const adminReports = require("../controllers/adminreports");
const {
  HOTEL_MANAGEMENT_RESERVATION_VISIBILITY_START,
} = require("../services/reservationVisibility");
const {
  RESERVATION_OVERVIEW_PROJECTION,
} = require("../services/adminReservationOverview");

const objectIdStrings = (values = []) => values.map((value) => String(value));

const createResponse = () => {
  const response = {
    statusCode: 200,
    payload: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return payload;
    },
  };
  return response;
};

const installReservationQueryStub = (captured, reservations = []) => {
  const originalFind = Reservations.find;
  Reservations.find = (filter) => {
    captured.filter = filter;
    const chain = {
      select(projection) {
        captured.projection = projection;
        return chain;
      },
      populate(path, projection) {
        captured.populate = { path, projection };
        return chain;
      },
      lean: async () => reservations,
    };
    return chain;
  };
  return () => {
    Reservations.find = originalFind;
  };
};

test("combined controller preserves selected-hotel, cancellation, and platform scopes", async (t) => {
  const selectedHotelId = new mongoose.Types.ObjectId();
  const secondSelectedHotelId = new mongoose.Types.ObjectId();
  const assignedHotelId = new mongoose.Types.ObjectId();
  const captured = {};
  const restoreReservations = installReservationQueryStub(captured);
  const originalHotelFind = HotelDetails.find;
  let capturedHotelFilter;
  HotelDetails.find = (filter, projection) => {
    capturedHotelFilter = { filter, projection };
    return {
      lean: async () => [
        { _id: selectedHotelId },
        { _id: secondSelectedHotelId },
      ],
    };
  };
  t.after(() => {
    restoreReservations();
    HotelDetails.find = originalHotelFind;
  });

  const req = {
    query: {
      hotels: "Selected Hotel,Second Hotel",
      excludeCancelled: "true",
      limit: "100",
    },
    profile: {
      _id: new mongoose.Types.ObjectId(),
      role: 1000,
      hotelIdsWork: [assignedHotelId],
    },
  };
  const res = createResponse();

  await adminReports.reservationOverview(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepStrictEqual(res.payload, {
    reservationsByDay: [],
    checkinsByDay: [],
    checkoutsByDay: [],
    reservationsByBookingStatus: [],
    reservationsByHotelNames: [],
    topHotels: [],
  });
  assert.deepStrictEqual(
    capturedHotelFilter.filter.hotelName.$in.map((regex) => regex.source),
    ["^Selected Hotel$", "^Second Hotel$"]
  );
  assert.deepStrictEqual(capturedHotelFilter.projection, { _id: 1 });

  assert.ok(Array.isArray(captured.filter.$and));
  assert.deepStrictEqual(
    objectIdStrings(captured.filter.$and[0].hotelId.$in),
    objectIdStrings([selectedHotelId, secondSelectedHotelId])
  );
  assert.deepStrictEqual(captured.filter.$and[0].reservation_status, {
    $nin: ["cancelled", "no show", "no_show", "noshow"],
  });
  assert.equal(
    captured.filter.$and[0].createdAt.$gte.toISOString(),
    "2025-05-01T00:00:00.000Z"
  );
  assert.deepStrictEqual(
    objectIdStrings(captured.filter.$and[1].hotelId.$in),
    objectIdStrings([assignedHotelId])
  );
  assert.equal(captured.projection, RESERVATION_OVERVIEW_PROJECTION);
  assert.deepStrictEqual(captured.populate, {
    path: "hotelId",
    projection: "hotelName",
  });
});

test("combined controller keeps the hotel-management history cutoff", async (t) => {
  const captured = {};
  const restoreReservations = installReservationQueryStub(captured);
  t.after(restoreReservations);
  const req = {
    query: { hotels: "all", excludeCancelled: "false" },
    profile: {
      _id: new mongoose.Types.ObjectId(),
      role: 2000,
      roleDescription: "hotel-manager",
    },
  };
  const res = createResponse();

  await adminReports.reservationOverview(req, res);

  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(captured.filter.$and));
  const visibility = captured.filter.$and[0];
  assert.deepStrictEqual(
    visibility.$or[0].booked_at.$gte,
    HOTEL_MANAGEMENT_RESERVATION_VISIBILITY_START
  );
  assert.deepStrictEqual(
    visibility.$or[1].$and[1].createdAt.$gte,
    HOTEL_MANAGEMENT_RESERVATION_VISIBILITY_START
  );
  assert.equal(captured.filter.reservation_status, undefined);
  assert.equal(captured.filter.hotelId, undefined);
});

test("combined controller payloads exactly match the six preserved legacy handlers", async (t) => {
  const reservations = [
    {
      createdAt: new Date("2026-07-01T10:00:00.000Z"),
      checkin_date: new Date("2026-07-10T10:00:00.000Z"),
      checkout_date: new Date("2026-07-12T10:00:00.000Z"),
      reservation_status: "confirmed",
      total_amount: 1000,
      hotelId: { _id: "hotel-a", hotelName: "Hotel A" },
      pickedRoomsType: [
        {
          count: 1,
          pricingByDay: [
            {
              rootPrice: 800,
              commissionRate: 10,
              totalPriceWithoutCommission: 900,
            },
          ],
        },
      ],
      paid_amount_breakdown: { paid_online_via_link: 200 },
    },
    {
      createdAt: new Date("2026-07-02T10:00:00.000Z"),
      checkin_date: null,
      checkout_date: null,
      reservation_status: "",
      total_amount: 500,
      hotelId: null,
      pickedRoomsType: [],
      customer_details: { cardNumber: "encrypted" },
      payment_details: { captured: false },
    },
  ];
  const captured = {};
  const restoreReservations = installReservationQueryStub(
    captured,
    reservations
  );
  t.after(restoreReservations);
  const req = {
    query: { hotels: "all", excludeCancelled: "true", limit: "100" },
    profile: { _id: new mongoose.Types.ObjectId(), role: 1000 },
  };
  const call = async (handler) => {
    const response = createResponse();
    await handler(req, response);
    assert.equal(response.statusCode, 200);
    return response.payload;
  };

  const legacy = {
    reservationsByDay: await call(adminReports.reservationsByDay),
    checkinsByDay: await call(adminReports.checkinsByDay),
    checkoutsByDay: await call(adminReports.checkoutsByDay),
    reservationsByBookingStatus: await call(
      adminReports.reservationsByBookingStatus
    ),
    reservationsByHotelNames: await call(adminReports.reservationsByHotelNames),
    topHotels: await call(adminReports.topHotelsByReservations),
  };
  const combined = await call(adminReports.reservationOverview);

  assert.deepStrictEqual(combined, legacy);
  assert.equal(
    combined.reservationsByHotelNames.some(
      (group) => group.hotelName === "Unknown Hotel"
    ),
    true
  );
  assert.equal(combined.reservationsByDay[0].paymentStatusCounts.captured, 1);
  assert.equal(combined.reservationsByDay[0].commission, 180);
});

test("admin combined route keeps the same authentication and access middleware", (t) => {
  const originalJwtSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = originalJwtSecret || "overview-route-test-secret";
  const auth = require("../controllers/auth");
  const controller = require("../controllers/adminreports");
  const routeModulePath = require.resolve("../routes/adminreports");
  const originalRequireAdminAccess = auth.requireAdminAccess;
  const allowedKeyCalls = [];
  const accessSentinel = (req, res, next) => next();
  auth.requireAdminAccess = (...allowedKeys) => {
    allowedKeyCalls.push(allowedKeys);
    return accessSentinel;
  };
  delete require.cache[routeModulePath];
  t.after(() => {
    auth.requireAdminAccess = originalRequireAdminAccess;
    delete require.cache[routeModulePath];
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;
  });

  const router = require("../routes/adminreports");
  const routeLayer = router.stack.find(
    (layer) =>
      layer.route?.path === "/adminreports/reservations-overview/:userId"
  );

  assert.ok(routeLayer, "combined admin route must be registered");
  const routeHandlers = routeLayer.route.stack.map((layer) => layer.handle);
  assert.deepStrictEqual(allowedKeyCalls[0], [
    "HotelReports",
    "AdminDashboard",
  ]);
  assert.deepStrictEqual(routeHandlers, [
    auth.requireSignin,
    auth.isAuth,
    accessSentinel,
    controller.reservationOverview,
  ]);
});
