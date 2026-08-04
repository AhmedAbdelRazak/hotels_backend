const test = require("node:test");
const assert = require("node:assert/strict");

const {
  RESERVATION_OVERVIEW_PROJECTION,
  buildReservationOverview,
} = require("./adminReservationOverview");

const safeNumber = (value) => {
  const parsed = Number(value);
  return isNaN(parsed) ? 0 : parsed;
};

const legacyPaymentStatus = (reservation) => {
  const breakdown = reservation?.paid_amount_breakdown || {};
  const breakdownCaptured = Object.keys(breakdown).some((key) => {
    if (key === "payment_comments") return false;
    const value = Number(breakdown[key]);
    return Number.isFinite(value) && value > 0;
  });
  if (breakdownCaptured) return "captured";

  const hasCardData =
    reservation?.customer_details?.cardNumber ||
    reservation?.customer_details?.cardHolderName ||
    reservation?.customer_details?.cardExpiryDate ||
    reservation?.customer_details?.cardCVV;
  if (!hasCardData) return "not paid";
  if (
    reservation?.payment_details?.finalCaptureTransactionId ||
    reservation?.payment_details?.captured === true
  ) {
    return "captured";
  }
  return "not captured";
};

const legacyCommission = (reservation) => {
  const hotelId = String(
    reservation?.hotelId?._id || reservation?.hotelId || ""
  );
  if (hotelId === "675c41a3fd79ed7586b970ee") {
    return 0.1 * safeNumber(reservation.total_amount);
  }
  if (!Array.isArray(reservation?.pickedRoomsType)) return 0;
  let total = 0;
  for (const room of reservation.pickedRoomsType) {
    if (!Array.isArray(room.pricingByDay)) continue;
    for (const day of room.pricingByDay) {
      const root = safeNumber(day.rootPrice);
      const rawRate = safeNumber(day.commissionRate);
      const rate = rawRate < 1 ? rawRate : rawRate / 100;
      total +=
        (root * rate + (safeNumber(day.totalPriceWithoutCommission) - root)) *
        safeNumber(room.count);
    }
  }
  return total;
};

const legacyGroup = (reservations, keyFor) => {
  const groups = {};
  for (const reservation of reservations) {
    const key = keyFor(reservation);
    if (!groups[key]) {
      groups[key] = {
        groupKey: key,
        reservationsCount: 0,
        total_amount: 0,
        commission: 0,
        paymentStatusCounts: {
          captured: 0,
          notCaptured: 0,
          notPaid: 0,
        },
      };
    }
    const group = groups[key];
    group.reservationsCount += 1;
    group.total_amount += safeNumber(reservation.total_amount);
    group.commission += legacyCommission(reservation);
    const status = legacyPaymentStatus(reservation);
    if (status === "captured") group.paymentStatusCounts.captured += 1;
    if (status === "not captured") group.paymentStatusCounts.notCaptured += 1;
    if (status === "not paid") group.paymentStatusCounts.notPaid += 1;
  }
  return Object.values(groups);
};

const legacyOverview = (reservations, requestedLimit) => {
  const day = (value) => new Date(value).toISOString().split("T")[0];
  const byHotel = legacyGroup(
    reservations,
    (reservation) => reservation.hotelId?.hotelName || "Unknown Hotel"
  );
  const hotelShape = (group) => ({
    hotelName: group.groupKey,
    reservationsCount: group.reservationsCount,
    total_amount: group.total_amount,
    commission: group.commission,
    paymentStatusCounts: group.paymentStatusCounts,
  });
  return {
    reservationsByDay: legacyGroup(reservations, (reservation) =>
      day(reservation.createdAt)
    ),
    checkinsByDay: legacyGroup(
      reservations.filter((reservation) => !!reservation.checkin_date),
      (reservation) => day(reservation.checkin_date)
    ),
    checkoutsByDay: legacyGroup(
      reservations.filter((reservation) => !!reservation.checkout_date),
      (reservation) => day(reservation.checkout_date)
    ),
    reservationsByBookingStatus: legacyGroup(
      reservations,
      (reservation) => reservation.reservation_status || "unknown"
    ).map((group) => ({
      reservation_status: group.groupKey,
      reservationsCount: group.reservationsCount,
      total_amount: group.total_amount,
      commission: group.commission,
      paymentStatusCounts: group.paymentStatusCounts,
    })),
    reservationsByHotelNames: byHotel.map(hotelShape),
    topHotels: [...byHotel]
      .sort((a, b) => b.reservationsCount - a.reservationsCount)
      .slice(0, Number(requestedLimit) || 5)
      .map(hotelShape),
  };
};

const fixture = [
  {
    createdAt: new Date("2026-07-01T12:00:00.000Z"),
    checkin_date: new Date("2026-07-10T12:00:00.000Z"),
    checkout_date: new Date("2026-07-12T12:00:00.000Z"),
    reservation_status: "confirmed",
    total_amount: "1200",
    hotelId: { _id: "hotel-a", hotelName: "Hotel A" },
    pickedRoomsType: [
      {
        count: 2,
        pricingByDay: [
          {
            rootPrice: 400,
            commissionRate: 10,
            totalPriceWithoutCommission: 450,
          },
        ],
      },
    ],
    paid_amount_breakdown: { paid_online_via_link: 100 },
  },
  {
    createdAt: new Date("2026-07-01T18:00:00.000Z"),
    checkin_date: new Date("2026-07-11T12:00:00.000Z"),
    checkout_date: null,
    reservation_status: "confirmed",
    total_amount: 600,
    hotelId: { _id: "hotel-a", hotelName: "Hotel A" },
    pickedRoomsType: [],
    customer_details: { cardNumber: "encrypted-card-value" },
    payment_details: { captured: false },
  },
  {
    createdAt: new Date("2026-07-02T18:00:00.000Z"),
    checkin_date: null,
    checkout_date: new Date("2026-07-15T12:00:00.000Z"),
    reservation_status: "",
    total_amount: "not-a-number",
    hotelId: null,
    pickedRoomsType: [],
    paid_amount_breakdown: { payment_comments: "not a payment" },
    customer_details: {},
  },
  {
    createdAt: new Date("2026-07-03T18:00:00.000Z"),
    checkin_date: new Date("2026-07-16T12:00:00.000Z"),
    checkout_date: new Date("2026-07-17T12:00:00.000Z"),
    reservation_status: "cancelled",
    total_amount: 900,
    hotelId: {
      _id: "675c41a3fd79ed7586b970ee",
      hotelName: "Special Hotel",
    },
    pickedRoomsType: [],
    customer_details: { cardHolderName: "encrypted-holder" },
    payment_details: { finalCaptureTransactionId: "capture-1" },
  },
];

test("combined overview is exactly parity-compatible with all six legacy payloads", () => {
  assert.deepStrictEqual(
    buildReservationOverview(fixture, 2),
    legacyOverview(fixture, 2)
  );
});

test("overview projection includes every calculation input and excludes bulky logs", () => {
  const selectedFields = new Set(RESERVATION_OVERVIEW_PROJECTION.split(" "));
  for (const required of [
    "createdAt",
    "checkin_date",
    "checkout_date",
    "reservation_status",
    "total_amount",
    "hotelId",
    "pickedRoomsType",
    "paid_amount_breakdown",
    "customer_details.cardNumber",
    "payment_details.captured",
  ]) {
    assert.equal(selectedFields.has(required), true, required);
  }

  for (const excluded of [
    "reservationAuditLog",
    "adminChangeLog",
    "changeLog",
    "aiSupportConversation",
  ]) {
    assert.equal(selectedFields.has(excluded), false, excluded);
  }
});
