/** @format */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.JWT_SECRET ||= "retired-payment-route-test-secret";
process.env.SENDGRID_API_KEY ||= "SG.retired-payment-route.placeholder";

const router = require("../routes/janat");
const {
	sendEmailForTriggeringPayment,
	triggeringSpecificTokenizedIdToCharge,
} = require("../controllers/janat");
const { requireSignin, isAuth } = require("../controllers/auth");

const routeFor = (path) =>
	router.stack.find((layer) => layer.route?.path === path)?.route;

const invokeRetiredHandler = (handler) => {
	let statusCode = null;
	let payload = null;
	const response = {
		status(code) {
			statusCode = code;
			return this;
		},
		json(value) {
			payload = value;
			return value;
		},
	};

	handler({}, response);
	return { statusCode, payload };
};

const expectedResponse = {
	success: false,
	code: "legacy_stored_card_payment_route_retired",
	error: "This legacy stored-card payment flow has been retired.",
};

test("the unauthenticated legacy stored-card payment route is retired", () => {
	const route = routeFor("/create-payment-client");
	assert.ok(route);
	assert.equal(route.methods.post, true);

	const handlers = route.stack.map((layer) => layer.handle);
	assert.equal(handlers.length, 1);
	assert.notEqual(handlers[0], triggeringSpecificTokenizedIdToCharge);
	assert.notEqual(handlers[0], sendEmailForTriggeringPayment);
	assert.deepEqual(invokeRetiredHandler(handlers[0]), {
		statusCode: 410,
		payload: expectedResponse,
	});
});

test("the authenticated legacy email issuer keeps auth and ends with 410", () => {
	const route = routeFor("/email-send/:userId");
	assert.ok(route);
	assert.equal(route.methods.post, true);

	const handlers = route.stack.map((layer) => layer.handle);
	assert.equal(handlers.length, 4);
	assert.equal(handlers[0], requireSignin);
	assert.equal(handlers[1], isAuth);
	assert.notEqual(handlers.at(-1), sendEmailForTriggeringPayment);
	assert.notEqual(handlers.at(-1), triggeringSpecificTokenizedIdToCharge);
	assert.equal(handlers.at(-1), routeFor("/create-payment-client").stack[0].handle);
	assert.deepEqual(invokeRetiredHandler(handlers.at(-1)), {
		statusCode: 410,
		payload: expectedResponse,
	});
});

test("the authenticated legacy stored-card charge keeps auth and ends with 410", () => {
	const route = routeFor("/create-payment/:userId");
	assert.ok(route);
	assert.equal(route.methods.post, true);

	const handlers = route.stack.map((layer) => layer.handle);
	assert.equal(handlers.length, 4);
	assert.equal(handlers[0], requireSignin);
	assert.equal(handlers[1], isAuth);
	assert.notEqual(handlers.at(-1), triggeringSpecificTokenizedIdToCharge);
	assert.notEqual(handlers.at(-1), sendEmailForTriggeringPayment);
	assert.equal(handlers.at(-1), routeFor("/create-payment-client").stack[0].handle);
	assert.deepEqual(invokeRetiredHandler(handlers.at(-1)), {
		statusCode: 410,
		payload: expectedResponse,
	});
});
