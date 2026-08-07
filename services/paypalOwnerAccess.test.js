"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET =
	process.env.JWT_SECRET || "paypal-owner-access-test-secret";
process.env.PAYPAL_CLIENT_ID_SANDBOX =
	process.env.PAYPAL_CLIENT_ID_SANDBOX || "paypal-owner-test-client";
process.env.PAYPAL_SECRET_KEY_SANDBOX =
	process.env.PAYPAL_SECRET_KEY_SANDBOX || "paypal-owner-test-secret";

const User = require("../models/user");
const HotelDetails = require("../models/hotel_details");
const auth = require("../controllers/auth");
const paypalOwner = require("../controllers/paypal_owner");
const {
	PAYPAL_OWNER_CAPABILITIES,
	canAccessPayPalOwnerHotel,
	canUseCapability,
} = require("./paypalOwnerAccess");

const id = (suffix) => `64c0000000000000000000${suffix}`;
const ownerA = id("01");
const ownerB = id("02");
const hotelA = id("11");
const hotelB = id("12");
const hotelB2 = id("13");
const financeUser = id("21");
const reservationEmployee = id("22");

const hotel = (_id, belongsTo) => ({ _id, belongsTo });
const actor = (_id, role, overrides = {}) => ({
	_id,
	role,
	activeUser: true,
	...overrides,
});

test("owner hotel scope rejects cross-owner and cross-hotel access", () => {
	assert.equal(
		canAccessPayPalOwnerHotel(
			actor(ownerA, 2000),
			hotel(hotelA, ownerA),
			PAYPAL_OWNER_CAPABILITIES.FINANCE
		),
		true
	);
	assert.equal(
		canAccessPayPalOwnerHotel(
			actor(ownerA, 2000),
			hotel(hotelB, ownerB),
			PAYPAL_OWNER_CAPABILITIES.FINANCE
		),
		false
	);

	const scopedFinance = actor(financeUser, 6000, {
		belongsToId: ownerB,
		hotelIdWork: hotelB,
	});
	assert.equal(
		canAccessPayPalOwnerHotel(
			scopedFinance,
			hotel(hotelB, ownerB),
			PAYPAL_OWNER_CAPABILITIES.FINANCE
		),
		true
	);
	assert.equal(
		canAccessPayPalOwnerHotel(
			scopedFinance,
			hotel(hotelB2, ownerB),
			PAYPAL_OWNER_CAPABILITIES.FINANCE
		),
		false
	);
	assert.equal(
		canAccessPayPalOwnerHotel(
			actor(id("24"), 6000, { hotelIdWork: hotelB }),
			hotel(hotelB, ownerB),
			PAYPAL_OWNER_CAPABILITIES.FINANCE
		),
		true,
		"legacy scoped finance users without belongsToId keep their assigned-hotel access"
	);
	assert.equal(
		canAccessPayPalOwnerHotel(
			actor(id("25"), 6000, {
				belongsToId: ownerA,
				hotelIdWork: hotelB,
			}),
			hotel(hotelB, ownerB),
			PAYPAL_OWNER_CAPABILITIES.FINANCE
		),
		false,
		"an explicit owner mismatch cannot be rescued by a stale hotelIdWork"
	);
	assert.equal(
		canUseCapability(
			actor(id("23"), 3000, { roleDescription: "reception" }),
			PAYPAL_OWNER_CAPABILITIES.PAYMENT_METHODS
		),
		false,
		"ordinary reception access must not extend to owner payment methods"
	);
});

test("route authorization denies anonymous and out-of-scope callers before handlers", async (t) => {
	const users = new Map([
		[ownerA, actor(ownerA, 2000)],
		[ownerB, actor(ownerB, 2000)],
		[
			financeUser,
			actor(financeUser, 6000, {
				belongsToId: ownerB,
				hotelIdWork: hotelB,
			}),
		],
		[
			reservationEmployee,
			actor(reservationEmployee, 8000, {
				belongsToId: ownerB,
				hotelIdWork: hotelB,
				roleDescription: "reservationemployee",
			}),
		],
	]);
	const hotels = new Map([
		[hotelA, hotel(hotelA, ownerA)],
		[hotelB, hotel(hotelB, ownerB)],
		[hotelB2, hotel(hotelB2, ownerB)],
	]);
	const queryFor = (value) => ({
		select() {
			return this;
		},
		lean() {
			return this;
		},
		async exec() {
			return value || null;
		},
	});

	const originalUserFindById = User.findById;
	const originalHotelFindById = HotelDetails.findById;
	User.findById = (value) => queryFor(users.get(String(value)));
	HotelDetails.findById = (value) => queryFor(hotels.get(String(value)));

	const controllerNames = [
		"generateClientToken",
		"createSetupToken",
		"vaultExchangeAndSave",
		"listPaymentMethods",
		"setDefaultMethod",
		"activateMethod",
		"deactivateMethod",
		"deleteMethod",
		"listHotelCommissions",
		"markCommissionsPaid",
		"chargeOwnerCommissions",
		"getHotelFinanceOverview",
	];
	const originalControllers = new Map(
		controllerNames.map((name) => [name, paypalOwner[name]])
	);
	let handlerCalls = 0;
	controllerNames.forEach((name) => {
		paypalOwner[name] = (req, res) => {
			handlerCalls += 1;
			return res.json({
				ok: true,
				handler: name,
				actorId: String(req.profile?._id || ""),
				hotelId: String(req.paypalOwnerHotel?._id || ""),
			});
		};
	});

	const routePath = require.resolve("../routes/paypal_owner");
	delete require.cache[routePath];
	const router = require("../routes/paypal_owner");
	const app = express();
	app.use(express.json());
	app.use(router);
	app.use((error, _req, res, _next) =>
		res.status(error?.status || error?.statusCode || 500).json({
			error: error?.code || error?.name || "request_failed",
		})
	);
	const server = http.createServer(app);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

	t.after(async () => {
		await new Promise((resolve) => server.close(resolve));
		User.findById = originalUserFindById;
		HotelDetails.findById = originalHotelFindById;
		originalControllers.forEach((value, name) => {
			paypalOwner[name] = value;
		});
		delete require.cache[routePath];
	});

	const baseUrl = `http://127.0.0.1:${server.address().port}`;
	const tokenFor = (actorId) =>
		jwt.sign({ _id: actorId }, process.env.JWT_SECRET, { expiresIn: "5m" });
	const request = async (path, { actorId, method = "GET", body } = {}) => {
		const headers = {};
		if (actorId) headers.Authorization = `Bearer ${tokenFor(actorId)}`;
		if (body !== undefined) headers["Content-Type"] = "application/json";
		const response = await fetch(`${baseUrl}${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		return {
			status: response.status,
			body: await response.json(),
		};
	};

	const protectedPaths = [
		"/paypal-owner/token-generated",
		"/paypal-owner/setup-token",
		"/paypal-owner/vault/exchange",
		"/paypal-owner/payment-methods/:hotelId",
		"/paypal-owner/payment-methods/set-default",
		"/paypal-owner/payment-methods/activate",
		"/paypal-owner/payment-methods/deactivate",
		"/paypal-owner/payment-methods/delete",
		"/paypal-owner/commissions",
		"/paypal-owner/commissions/mark-paid",
		"/paypal-owner/commissions/charge",
		"/finance/overview",
	];
	for (const path of protectedPaths) {
		const layer = router.stack.find((item) => item.route?.path === path);
		assert.ok(layer, `${path} must remain registered`);
		assert.equal(
			layer.route.stack[0]?.handle,
			auth.requireSignin,
			`${path} must authenticate before access checks or controller work`
		);
	}

	const anonymous = await request(
		`/paypal-owner/commissions?hotelId=${hotelA}`
	);
	assert.equal(anonymous.status, 401);
	assert.equal(handlerCalls, 0);

	const crossOwner = await request(
		`/paypal-owner/commissions?hotelId=${hotelB}`,
		{ actorId: ownerA }
	);
	assert.equal(crossOwner.status, 403);
	assert.equal(handlerCalls, 0);

	const crossHotel = await request(
		`/paypal-owner/commissions?hotelId=${hotelB2}`,
		{ actorId: financeUser }
	);
	assert.equal(crossHotel.status, 403);
	assert.equal(handlerCalls, 0);

	const authorizedOwner = await request(
		`/paypal-owner/commissions?hotelId=${hotelA}`,
		{ actorId: ownerA }
	);
	assert.equal(authorizedOwner.status, 200);
	assert.equal(authorizedOwner.body.actorId, ownerA);
	assert.equal(authorizedOwner.body.hotelId, hotelA);

	const authorizedFinance = await request(
		"/paypal-owner/commissions/charge",
		{
			actorId: financeUser,
			method: "POST",
			body: { hotelId: hotelB, reservationIds: [id("31")] },
		}
	);
	assert.equal(authorizedFinance.status, 200);
	assert.equal(authorizedFinance.body.actorId, financeUser);
	assert.equal(authorizedFinance.body.hotelId, hotelB);

	const paymentMethodOnly = await request(
		`/paypal-owner/payment-methods/${hotelB}`,
		{ actorId: reservationEmployee }
	);
	assert.equal(paymentMethodOnly.status, 200);
	const financeDenied = await request(
		`/paypal-owner/commissions?hotelId=${hotelB}`,
		{ actorId: reservationEmployee }
	);
	assert.equal(financeDenied.status, 403);
});
