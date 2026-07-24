/** @format */

"use strict";

const normalizeId = (value) =>
	String(value?._id || value?.id || value || "").trim();

const configuredSuperAdminIds = () =>
	[process.env.SUPER_ADMIN_ID, process.env.REACT_APP_SUPER_ADMIN_ID]
		.flatMap((value) => String(value || "").split(","))
		.map((id) => id.trim())
		.filter(Boolean);

const accountRoleNumbers = (account = {}) =>
	[
		Number(account.role),
		...(Array.isArray(account.roles) ? account.roles.map(Number) : []),
	].filter(Boolean);

const isConfiguredSuperAdmin = (account = {}) =>
	configuredSuperAdminIds().includes(normalizeId(account));

/**
 * Inventory overrides belong to XHotelPro platform staff only. Platform staff
 * accounts are issued role 1000; hotel OrderTakers/agents use role 7000 and
 * intentionally do not qualify.
 */
const canPlatformStaffOverrideReservationInventory = (account = {}) => {
	if (!account || account.activeUser === false) return false;
	return (
		isConfiguredSuperAdmin(account) || accountRoleNumbers(account).includes(1000)
	);
};

const canUseEmployeeReservationInventoryOverride = ({
	account = {},
	sentFrom = "",
} = {}) =>
	String(sentFrom || "").trim().toLowerCase() === "employee" &&
	canPlatformStaffOverrideReservationInventory(account);

module.exports = {
	accountRoleNumbers,
	canPlatformStaffOverrideReservationInventory,
	canUseEmployeeReservationInventoryOverride,
	isConfiguredSuperAdmin,
	normalizeId,
};
