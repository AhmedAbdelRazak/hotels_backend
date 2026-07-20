const mongoose = require("mongoose");

const ObjectId = mongoose.Types.ObjectId;

const normalizeId = (value) => String(value?._id || value || "").trim();

const configuredSuperAdminIds = (env = process.env) =>
  [env.SUPER_ADMIN_ID, env.REACT_APP_SUPER_ADMIN_ID]
    .flatMap((value) => String(value || "").split(","))
    .map((id) => id.trim())
    .filter(Boolean);

const isConfiguredSuperAdmin = (actor = {}, env = process.env) =>
  configuredSuperAdminIds(env).includes(normalizeId(actor));

const roleNumbers = (actor = {}) =>
  [
    Number(actor.role),
    ...(Array.isArray(actor.roles) ? actor.roles.map(Number) : []),
  ].filter(Number.isFinite);

const assignedHotelIds = (actor = {}) =>
  [
    actor.hotelIdWork,
    ...(Array.isArray(actor.hotelIdsWork) ? actor.hotelIdsWork : []),
    ...(Array.isArray(actor.hotelsToSupport) ? actor.hotelsToSupport : []),
    ...(Array.isArray(actor.hotelIdsOwner) ? actor.hotelIdsOwner : []),
  ]
    .map(normalizeId)
    .filter(
      (id, index, values) =>
        ObjectId.isValid(id) && values.indexOf(id) === index,
    );

/**
 * Mirrors the visibility contract of the existing admin reservation list:
 * configured super admins can see every hotel, while role-1000 platform staff
 * can see only their explicitly assigned hotels. Other authorized admin-panel
 * roles retain the existing global behavior enforced by requireAdminAccess.
 */
const buildAdminReservationCycleHotelFilter = (
  actor = {},
  env = process.env,
) => {
  if (
    isConfiguredSuperAdmin(actor, env) ||
    !roleNumbers(actor).includes(1000)
  ) {
    return {};
  }

  return {
    _id: {
      $in: assignedHotelIds(actor).map((id) => ObjectId(id)),
    },
  };
};

/**
 * The overall financial query considers every role-1000 account a global
 * super admin. For an assigned platform employee, remove that role only from
 * the read-query context so wallet/agent rows are restricted to the same hotel
 * set. Platform history/source visibility is kept explicitly.
 */
const actorForAdminReservationCycleQuery = (actor = {}, env = process.env) => {
  const plain =
    typeof actor?.toObject === "function" ? actor.toObject() : { ...actor };
  if (
    isConfiguredSuperAdmin(plain, env) ||
    !roleNumbers(plain).includes(1000)
  ) {
    return {
      ...plain,
      accountScope: plain.accountScope || "platform",
      platformEmployee: true,
    };
  }

  return {
    ...plain,
    role: Number(plain.role) === 1000 ? undefined : plain.role,
    roles: Array.isArray(plain.roles)
      ? plain.roles.filter((role) => Number(role) !== 1000)
      : [],
    roleDescription: "platformstaff",
    roleDescriptions: [
      ...(Array.isArray(plain.roleDescriptions)
        ? plain.roleDescriptions.filter(
            (description) =>
              !/^super[\s_-]*admin$/i.test(String(description || "")),
          )
        : []),
      "platformstaff",
    ],
    accountScope: "platform",
    platformEmployee: true,
  };
};

const buildAdminPendingConfirmationQuery = (query = {}) => ({
  ...(query || {}),
  status: "Pending Confirmation",
});

module.exports = {
  actorForAdminReservationCycleQuery,
  assignedHotelIds,
  buildAdminPendingConfirmationQuery,
  buildAdminReservationCycleHotelFilter,
  configuredSuperAdminIds,
  isConfiguredSuperAdmin,
};
