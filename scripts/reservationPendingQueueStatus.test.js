const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildActivePendingQueueFilter,
  isPendingConfirmationReservation,
  isTerminalPendingQueueReservation,
} = require("../services/reservationStatus");

test("terminal lifecycle states always win over stale pending metadata", () => {
  ["Cancelled", "canceled", "In House", "checked_in", "Checked Out", "closed"].forEach(
    (status) => {
      const reservation = {
        reservation_status: status,
        pendingConfirmation: { status: "pending" },
      };
      assert.equal(isTerminalPendingQueueReservation(reservation), true, status);
      assert.equal(isPendingConfirmationReservation(reservation), false, status);
    },
  );
});

test("active pending reservations remain eligible", () => {
  assert.equal(
    isPendingConfirmationReservation({
      reservation_status: "Pending Confirmation",
      pendingConfirmation: { status: "pending" },
    }),
    true,
  );
});

test("database pending queues exclude terminal values in either lifecycle field", () => {
  const filter = buildActivePendingQueueFilter();
  assert.ok(filter.$nor[0].reservation_status.test("InHouse"));
  assert.ok(filter.$nor[0].reservation_status.test("checked-out"));
  assert.ok(filter.$nor[1].state.test("Cancelled"));
  assert.equal(filter.$nor[0].reservation_status.test("Pending Finance Review"), false);
});
