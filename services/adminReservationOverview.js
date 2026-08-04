const RESERVATION_OVERVIEW_PROJECTION = [
  "createdAt",
  "checkin_date",
  "checkout_date",
  "reservation_status",
  "total_amount",
  "hotelId",
  "pickedRoomsType",
  "paid_amount_breakdown",
  "customer_details.cardNumber",
  "customer_details.cardHolderName",
  "customer_details.cardExpiryDate",
  "customer_details.cardCVV",
  "payment_details.finalCaptureTransactionId",
  "payment_details.captured",
].join(" ");

const safeNumber = (value) => {
  const parsed = Number(value);
  return isNaN(parsed) ? 0 : parsed;
};

const getPaymentStatus = (reservation) => {
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

  const paymentDetails = reservation?.payment_details;
  if (
    paymentDetails?.finalCaptureTransactionId ||
    paymentDetails?.captured === true
  ) {
    return "captured";
  }

  return "not captured";
};

const computeReservationCommission = (reservation) => {
  if (!reservation) return 0;

  const specialHotelId = "675c41a3fd79ed7586b970ee";
  const currentHotelId = String(
    reservation.hotelId?._id || reservation.hotelId || ""
  );
  if (currentHotelId === specialHotelId) {
    return 0.1 * safeNumber(reservation.total_amount);
  }

  if (!Array.isArray(reservation.pickedRoomsType)) return 0;

  let totalCommission = 0;
  for (const room of reservation.pickedRoomsType) {
    if (!Array.isArray(room.pricingByDay)) continue;

    for (const day of room.pricingByDay) {
      const rootPrice = safeNumber(day.rootPrice);
      const rawRate = safeNumber(day.commissionRate);
      const finalRate = rawRate < 1 ? rawRate : rawRate / 100;
      const totalPriceWithoutCommission = safeNumber(
        day.totalPriceWithoutCommission
      );
      const dayCommission =
        rootPrice * finalRate + (totalPriceWithoutCommission - rootPrice);
      totalCommission += dayCommission * safeNumber(room.count);
    }
  }

  return totalCommission;
};

const newGroup = (groupKey) => ({
  groupKey,
  reservationsCount: 0,
  total_amount: 0,
  commission: 0,
  paymentStatusCounts: {
    captured: 0,
    notCaptured: 0,
    notPaid: 0,
  },
});

const addToGroup = (groups, key, reservationMetrics) => {
  if (!groups[key]) groups[key] = newGroup(key);
  const group = groups[key];
  group.reservationsCount += 1;
  group.total_amount += reservationMetrics.totalAmount;
  group.commission += reservationMetrics.commission;

  if (reservationMetrics.paymentStatus === "captured") {
    group.paymentStatusCounts.captured += 1;
  } else if (reservationMetrics.paymentStatus === "not captured") {
    group.paymentStatusCounts.notCaptured += 1;
  } else if (reservationMetrics.paymentStatus === "not paid") {
    group.paymentStatusCounts.notPaid += 1;
  }
};

const dayKey = (value) => new Date(value).toISOString().split("T")[0];

/**
 * Build every chart payload used by the admin reservations report in one pass.
 * The field names and insertion/sort order intentionally match the legacy six
 * endpoints so the UI can switch transports without changing report results.
 */
const buildReservationOverview = (reservations = [], requestedTopLimit = 5) => {
  const byReservationDay = {};
  const byCheckinDay = {};
  const byCheckoutDay = {};
  const byBookingStatus = {};
  const byHotelName = {};

  for (const reservation of reservations) {
    const metrics = {
      totalAmount: safeNumber(reservation.total_amount),
      commission: computeReservationCommission(reservation),
      paymentStatus: getPaymentStatus(reservation),
    };

    addToGroup(byReservationDay, dayKey(reservation.createdAt), metrics);
    if (reservation.checkin_date) {
      addToGroup(byCheckinDay, dayKey(reservation.checkin_date), metrics);
    }
    if (reservation.checkout_date) {
      addToGroup(byCheckoutDay, dayKey(reservation.checkout_date), metrics);
    }
    addToGroup(
      byBookingStatus,
      reservation.reservation_status || "unknown",
      metrics
    );
    addToGroup(
      byHotelName,
      reservation.hotelId?.hotelName || "Unknown Hotel",
      metrics
    );
  }

  const hotelGroups = Object.values(byHotelName);
  const limit = Number(requestedTopLimit) || 5;
  const topHotels = [...hotelGroups]
    .sort((a, b) => b.reservationsCount - a.reservationsCount)
    .slice(0, limit)
    .map((group) => ({
      hotelName: group.groupKey,
      reservationsCount: group.reservationsCount,
      total_amount: group.total_amount,
      commission: group.commission,
      paymentStatusCounts: group.paymentStatusCounts,
    }));

  return {
    reservationsByDay: Object.values(byReservationDay),
    checkinsByDay: Object.values(byCheckinDay),
    checkoutsByDay: Object.values(byCheckoutDay),
    reservationsByBookingStatus: Object.values(byBookingStatus).map(
      (group) => ({
        reservation_status: group.groupKey,
        reservationsCount: group.reservationsCount,
        total_amount: group.total_amount,
        commission: group.commission,
        paymentStatusCounts: group.paymentStatusCounts,
      })
    ),
    reservationsByHotelNames: hotelGroups.map((group) => ({
      hotelName: group.groupKey,
      reservationsCount: group.reservationsCount,
      total_amount: group.total_amount,
      commission: group.commission,
      paymentStatusCounts: group.paymentStatusCounts,
    })),
    topHotels,
  };
};

module.exports = {
  RESERVATION_OVERVIEW_PROJECTION,
  buildReservationOverview,
};
