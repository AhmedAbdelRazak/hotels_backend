/** @format */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.JWT_SECRET ||= "retired-route-test-secret";
process.env.SENDGRID_API_KEY ||= "SG.retired-route.placeholder";

const router = require("../routes/janat");
const { updateReservationDetails } = require("../controllers/janat");

test("the unauthenticated reservation update route is retired with 410", () => {
	const route = router.stack.find(
		(layer) =>
			layer.route?.path === "/update-reservation-client/:reservationId"
	);
	assert.ok(route);
	assert.equal(route.route.methods.put, true);
	const handlers = route.route.stack.map((layer) => layer.handle);
	assert.equal(handlers.length, 1);
	assert.notEqual(handlers[0], updateReservationDetails);

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
	handlers[0]({ params: { reservationId: "unused" } }, response);

	assert.equal(statusCode, 410);
	assert.deepEqual(payload, {
		success: false,
		code: "reservation_client_update_route_retired",
		error: "This unauthenticated reservation update endpoint has been retired.",
	});
});
