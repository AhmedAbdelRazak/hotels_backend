/** @format */

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

process.env.SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "SG.test";
process.env.AI_AGENT_TEST_EXPORTS = "true";
process.env.SUPER_ADMIN_ID = "configured-super-admin";

const {
	canPlatformStaffOverrideReservationInventory,
	canUseEmployeeReservationInventoryOverride,
} = require("../services/reservationInventoryOverridePolicy");
const reservationAccess = require("../controllers/reservations").__test;

test("platform admins can override inventory while OrderTakers and agents cannot", () => {
	assert.equal(
		canPlatformStaffOverrideReservationInventory({
			_id: "platform-admin",
			role: 1000,
			activeUser: true,
		}),
		true,
	);
	assert.equal(
		canPlatformStaffOverrideReservationInventory({
			_id: "configured-super-admin",
			activeUser: true,
		}),
		true,
	);
	assert.equal(
		canPlatformStaffOverrideReservationInventory({
			_id: "order-taker",
			role: 7000,
			roleDescription: "ordertaker",
			activeUser: true,
		}),
		false,
	);
	assert.equal(
		canPlatformStaffOverrideReservationInventory({
			_id: "inactive-platform-admin",
			role: 1000,
			activeUser: false,
		}),
		false,
	);
});

test("the employee endpoint override requires both employee origin and platform staff", () => {
	const platformAdmin = { role: 1000, activeUser: true };
	assert.equal(
		canUseEmployeeReservationInventoryOverride({
			account: platformAdmin,
			sentFrom: "employee",
		}),
		true,
	);
	assert.equal(
		canUseEmployeeReservationInventoryOverride({
			account: platformAdmin,
			sentFrom: "public",
		}),
		false,
	);
	assert.equal(
		canUseEmployeeReservationInventoryOverride({
			account: { role: 7000, activeUser: true },
			sentFrom: "employee",
		}),
		false,
	);
});

test("admin edits stay unrestricted while OrderTaker edits remain restricted", () => {
	assert.equal(
		reservationAccess.isRestrictedOrderTakerReservationActor({
			role: 7000,
			roleDescription: "ordertaker",
			activeUser: true,
		}),
		true,
	);
	assert.equal(
		reservationAccess.isRestrictedOrderTakerReservationActor({
			role: 7000,
			roleDescription: "ordertaker",
			roleDescriptions: ["superadmin"],
			activeUser: true,
		}),
		true,
	);
	assert.equal(
		reservationAccess.isRestrictedOrderTakerReservationActor({
			role: 1000,
			roles: [1000, 7000],
			roleDescription: "platformstaff",
			accessTo: ["ownReservations", "AllReservations"],
			activeUser: true,
		}),
		false,
	);
	assert.equal(
		reservationAccess.isRestrictedOrderTakerReservationActor({
			_id: "configured-super-admin",
			accessTo: ["ownReservations"],
			activeUser: true,
		}),
		false,
	);
});

test("generic reservation updates are scoped to the actor's exact hotel", () => {
	const hotel = { _id: "hotel-a", belongsTo: "owner-a" };
	assert.equal(
		reservationAccess.canUpdateReservationHotelScope(
			{
				_id: "platform-staff",
				role: 1000,
				activeUser: true,
				hotelIdsWork: ["hotel-a"],
			},
			hotel,
		),
		true,
	);
	assert.equal(
		reservationAccess.canUpdateReservationHotelScope(
			{ _id: "platform-staff", role: 1000, activeUser: true },
			hotel,
		),
		false,
	);
	assert.equal(
		reservationAccess.canUpdateReservationHotelScope(
			{ _id: "owner-a", role: 2000, activeUser: true },
			hotel,
		),
		true,
	);
	assert.equal(
		reservationAccess.canUpdateReservationHotelScope(
			{
				_id: "inactive-staff",
				role: 8000,
				activeUser: false,
				hotelIdWork: "hotel-a",
			},
			hotel,
		),
		false,
	);
	assert.equal(
		reservationAccess.canUpdateReservationHotelScope(
			{ _id: "configured-super-admin", activeUser: true },
			hotel,
		),
		true,
	);
	assert.equal(
		reservationAccess.canUpdateReservationHotelScope(
			{ _id: "configured-super-admin", activeUser: false },
			hotel,
		),
		false,
	);
});

test("generic reservation updates cannot forge HotelRunner or OTA authority markers", () => {
	const payload = {
		otaIdentityKey: "booking:forged",
		otaCrossTransportIdentityKey: "trip:forged",
		otaPlatformReview: { status: "released" },
		supplierData: {
			supplierName: "Booking.com",
			suppliedBookingNo: "SAFE-123",
			customReference: "allowed-legacy-field",
			hotelRunner: { transport: "hotelrunner_api" },
			hotelRunnerEmailCommercialEvidence: { verified: true },
			otaAutomationPipeline: "hotelrunner-background-worker",
			otaSourceAuthority: 4,
			otaProvider: "booking",
		},
		"supplierData.hotelRunner.transport": "hotelrunner_api",
		"supplierData.otaAutomationPipeline": "hotelrunner-background-worker",
	};

	reservationAccess.stripServerManagedReservationUpdateFields(payload);
	const normalized =
		reservationAccess.normalizeSupplierDataUpdateFields(payload);

	assert.equal(normalized.otaIdentityKey, undefined);
	assert.equal(normalized.otaCrossTransportIdentityKey, undefined);
	assert.equal(normalized.otaPlatformReview, undefined);
	assert.equal(normalized["supplierData.hotelRunner"], undefined);
	assert.equal(normalized["supplierData.hotelRunner.transport"], undefined);
	assert.equal(normalized["supplierData.otaAutomationPipeline"], undefined);
	assert.equal(normalized["supplierData.otaSourceAuthority"], undefined);
	assert.equal(normalized["supplierData.otaProvider"], undefined);
	assert.equal(normalized["supplierData.supplierName"], "Booking.com");
	assert.equal(normalized["supplierData.suppliedBookingNo"], "SAFE-123");
	assert.equal(
		normalized["supplierData.customReference"],
		"allowed-legacy-field",
	);
});

const otaAdminManagedReservation = () => ({
	adminPricingVisibility: {
		rootOnlyForHotelManagement: true,
	},
	supplierData: {
		otaAutomationPipeline: "ota-email-orchestrator",
	},
	pickedRoomsType: [
		{
			room_type: "familyRooms",
			displayName: "Family Quintuple Room",
			count: 1,
		},
	],
	pickedRoomsPricing: [
		{
			room_type: "familyRooms",
			displayName: "Family Quintuple Room",
			count: 1,
			pricingByDay: [{ date: "2026-07-20", price: 50 }],
		},
	],
});

const completeAdminPricingUpdate = () => ({
	checkin_date: "2026-07-20",
	checkout_date: "2026-07-25",
	pickedRoomsType: [
		{
			room_type: "familyRooms",
			displayName: "Family Quintuple Room",
			count: 1,
		},
	],
	pickedRoomsPricing: [
		{
			room_type: "familyRooms",
			displayName: "Family Quintuple Room",
			count: 1,
			pricingByDay: [
				{ date: "2026-07-20", price: 45.47 },
				{ date: "2026-07-21", price: 45.47 },
				{ date: "2026-07-22", price: 45.47 },
				{ date: "2026-07-23", price: 45.47 },
				{ date: "2026-07-24", price: 45.48 },
			],
		},
	],
	total_rooms: 1,
	total_amount: 227.36,
	adminPricing: {
		mode: "admin_three_price",
		clientTotal: 227.36,
	},
});

test("platform admins can update complete OTA pricing through the regular reservation route", () => {
	assert.deepEqual(
		reservationAccess.protectAdminManagedPricingUpdate({
			updates: completeAdminPricingUpdate(),
			reservation: otaAdminManagedReservation(),
			actor: { role: 1000, activeUser: true },
			hasExplicitPricingIntent: true,
		}),
		{ allowed: true },
	);
});

test("OTA pricing remains protected from OrderTakers and incomplete admin payloads", () => {
	const orderTakerResult =
		reservationAccess.protectAdminManagedPricingUpdate({
			updates: completeAdminPricingUpdate(),
			reservation: otaAdminManagedReservation(),
			actor: { role: 7000, activeUser: true },
			hasExplicitPricingIntent: true,
		});
	assert.equal(orderTakerResult.allowed, false);
	assert.equal(orderTakerResult.status, 409);
	assert.equal(orderTakerResult.code, "ota_pricing_dedicated_route_required");

	const incompleteAdminResult =
		reservationAccess.protectAdminManagedPricingUpdate({
			updates: {
				...completeAdminPricingUpdate(),
				pickedRoomsPricing: [],
			},
			reservation: otaAdminManagedReservation(),
			actor: { role: 1000, activeUser: true },
			hasExplicitPricingIntent: true,
		});
	assert.equal(incompleteAdminResult.allowed, false);
	assert.equal(incompleteAdminResult.status, 409);
	assert.equal(
		incompleteAdminResult.code,
		"ota_pricing_dedicated_route_required",
	);
});

test("the employee creation route stays authenticated and admin-access scoped", () => {
	const routeSource = fs.readFileSync(
		require.resolve("../routes/janat"),
		"utf8",
	);
	assert.match(
		routeSource,
		/router\.post\(\s*["']\/new-reservation-client-employee["'][\s\S]*?requireSignin,[\s\S]*?requireAdminAccess\(["']JannatTools["']\),[\s\S]*?createNewReservationClient2\s*\)/,
	);
});

test("only the employee creation controller applies the platform override policy", () => {
	const controllerSource = fs.readFileSync(
		require.resolve("../controllers/janat"),
		"utf8",
	);
	const publicStart = controllerSource.indexOf(
		"exports.createNewReservationClient = async",
	);
	const employeeStart = controllerSource.indexOf(
		"exports.createNewReservationClient2 = async",
	);
	const employeeEnd = controllerSource.indexOf("\nexports.", employeeStart + 1);
	const publicController = controllerSource.slice(publicStart, employeeStart);
	const employeeController = controllerSource.slice(
		employeeStart,
		employeeEnd >= 0 ? employeeEnd : controllerSource.length,
	);

	assert.ok(publicStart >= 0);
	assert.ok(employeeStart > publicStart);
	assert.doesNotMatch(
		publicController,
		/canUseEmployeeReservationInventoryOverride/,
	);
	assert.match(
		employeeController,
		/allowOverbook:\s*canUseEmployeeReservationInventoryOverride\(\{[\s\S]*?account:\s*req\.profile,[\s\S]*?sentFrom/,
	);
});
