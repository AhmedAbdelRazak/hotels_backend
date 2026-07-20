const test = require("node:test");
const assert = require("node:assert/strict");
const {
  actorForAdminReservationCycleQuery,
  assignedHotelIds,
  buildAdminPendingConfirmationQuery,
  buildAdminReservationCycleHotelFilter,
} = require("../services/adminReservationCycleScope");

const HOTEL_A = "68b74714fb50e159d48c714d";
const HOTEL_B = "68b74714fb50e159d48c714e";
const ADMIN_ID = "68b74714fb50e159d48c714f";

test("deduplicates and validates every supported admin hotel assignment", () => {
  assert.deepEqual(
    assignedHotelIds({
      hotelIdWork: HOTEL_A,
      hotelIdsWork: [HOTEL_B, "invalid"],
      hotelsToSupport: [{ _id: HOTEL_A }],
      hotelIdsOwner: [null],
    }),
    [HOTEL_A, HOTEL_B],
  );
});

test("scopes an ordinary role-1000 admin to assigned hotels", () => {
  const filter = buildAdminReservationCycleHotelFilter(
    {
      _id: ADMIN_ID,
      role: 1000,
      hotelsToSupport: [HOTEL_A, HOTEL_B],
    },
    {},
  );

  assert.deepEqual(filter._id.$in.map(String), [HOTEL_A, HOTEL_B]);
});

test("an unassigned role-1000 admin receives an explicit empty hotel scope", () => {
  const filter = buildAdminReservationCycleHotelFilter(
    { _id: ADMIN_ID, role: 1000 },
    {},
  );
  assert.deepEqual(filter._id.$in, []);
});

test("configured super admins retain global reservation-cycle scope", () => {
  const filter = buildAdminReservationCycleHotelFilter(
    { _id: ADMIN_ID, role: 1000 },
    { SUPER_ADMIN_ID: `another-id, ${ADMIN_ID}` },
  );
  assert.deepEqual(filter, {});
});

test("assigned admins use a non-global financial query actor without mutation", () => {
  const source = {
    _id: ADMIN_ID,
    role: 1000,
    roles: [1000],
    roleDescription: "super admin",
    accessTo: ["HotelsReservations"],
  };
  const queryActor = actorForAdminReservationCycleQuery(source, {});

  assert.equal(source.role, 1000);
  assert.deepEqual(source.roles, [1000]);
  assert.equal(queryActor.role, undefined);
  assert.deepEqual(queryActor.roles, []);
  assert.equal(queryActor.roleDescription, "platformstaff");
  assert.equal(queryActor.accountScope, "platform");
  assert.equal(queryActor.platformEmployee, true);
});

test("the admin confirmation stage cannot be changed into a finance-stage query", () => {
  const original = {
    page: "4",
    status: "Pending Finance Review",
    search: "AGODA-123",
  };
  assert.deepEqual(buildAdminPendingConfirmationQuery(original), {
    page: "4",
    status: "Pending Confirmation",
    search: "AGODA-123",
  });
  assert.equal(original.status, "Pending Finance Review");
});
