/** @format */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.JWT_SECRET ||= "reconciliation-route-test-secret";
process.env.SENDGRID_API_KEY ||= "SG.route-test.placeholder";

const router = require("../routes/reconciliation");
const reconciliationController = require("../controllers/reconciliation");
const { userById } = require("../controllers/user");
const { isAuth } = require("../controllers/auth");

test("reconciliation routes wire authenticated report and patch handlers", () => {
	const routes = router.stack
		.filter((layer) => layer.route)
		.map((layer) => ({
			path: layer.route.path,
			methods: layer.route.methods,
			handlers: layer.route.stack.map((item) => item.handle),
		}));
	assert.equal(routes.length, 2);
	assert.equal(routes[0].path, "/reconciliation/report/:userId");
	assert.equal(routes[0].methods.get, true);
	assert.equal(
		routes[0].handlers.at(-1),
		reconciliationController.reconciliationReport
	);
	assert.ok(routes[0].handlers.includes(isAuth));
	assert.ok(routes[0].handlers.length >= 4);

	assert.equal(routes[1].path, "/reconciliation/status/:userId");
	assert.equal(routes[1].methods.patch, true);
	assert.equal(
		routes[1].handlers.at(-1),
		reconciliationController.updateReconciliationStatus
	);
	assert.ok(routes[1].handlers.includes(isAuth));
	assert.ok(routes[1].handlers.length >= 4);
});

test("reconciliation router registers userId loading", () => {
	assert.ok(router.params && Array.isArray(router.params.userId));
	assert.equal(router.params.userId.length, 1);
	assert.equal(router.params.userId[0], userById);
});
