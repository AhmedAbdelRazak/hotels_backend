/** @format */

"use strict";

process.env.SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "SG.test";

const test = require("node:test");
const assert = require("node:assert/strict");
const { requireInboundSecret } = require("../controllers/otaInbound");

const responseMock = () => ({
	statusCode: 200,
	headers: {},
	body: "",
	set(name, value) {
		this.headers[name] = value;
		return this;
	},
	status(code) {
		this.statusCode = code;
		return this;
	},
	send(body) {
		this.body = body;
		return this;
	},
});

const requestMock = ({ token = "", header = "" } = {}) => ({
	query: token ? { token } : {},
	get(name) {
		return String(name).toLowerCase() === "x-inbound-secret" ? header : "";
	},
});

test("inbound authentication fails closed when the production secret is absent", () => {
	const previous = process.env.SENDGRID_INBOUND_SECRET;
	delete process.env.SENDGRID_INBOUND_SECRET;
	const res = responseMock();
	let called = false;
	requireInboundSecret(requestMock(), res, () => {
		called = true;
	});
	assert.equal(called, false);
	assert.equal(res.statusCode, 503);
	assert.equal(res.headers["Retry-After"], "300");
	if (previous === undefined) delete process.env.SENDGRID_INBOUND_SECRET;
	else process.env.SENDGRID_INBOUND_SECRET = previous;
});

test("inbound authentication accepts only the exact query or header secret", () => {
	const previous = process.env.SENDGRID_INBOUND_SECRET;
	process.env.SENDGRID_INBOUND_SECRET = "expected-secret";

	for (const req of [
		requestMock({ token: "expected-secret" }),
		requestMock({ header: "expected-secret" }),
	]) {
		const res = responseMock();
		let called = false;
		requireInboundSecret(req, res, () => {
			called = true;
		});
		assert.equal(called, true);
		assert.equal(res.statusCode, 200);
	}

	const rejected = responseMock();
	requireInboundSecret(requestMock({ token: "wrong" }), rejected, () => {});
	assert.equal(rejected.statusCode, 401);

	if (previous === undefined) delete process.env.SENDGRID_INBOUND_SECRET;
	else process.env.SENDGRID_INBOUND_SECRET = previous;
});

