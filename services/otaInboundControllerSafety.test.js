/** @format */

"use strict";

process.env.SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "SG.test";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
	parseSendGridPayload,
	requireInboundSecret,
} = require("../controllers/otaInbound");
const {
	extractNormalizedReservation,
	isStaleOtaLifecycleEvent,
	reconcileOtaReservation,
} = require("./otaReservationMapper");

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

test("inbound authentication supports a zero-downtime two-secret rotation window", () => {
	const previous = process.env.SENDGRID_INBOUND_SECRET;
	process.env.SENDGRID_INBOUND_SECRET = "old-secret,new-secret";
	for (const token of ["old-secret", "new-secret"]) {
		const res = responseMock();
		let called = false;
		requireInboundSecret(requestMock({ token }), res, () => {
			called = true;
		});
		assert.equal(called, true, token);
	}
	if (previous === undefined) delete process.env.SENDGRID_INBOUND_SECRET;
	else process.env.SENDGRID_INBOUND_SECRET = previous;
});

test("SendGrid SPF authentication is accepted only with an aligned envelope sender", async () => {
	const delayedAuthenticatedDate = new Date(Date.now() - 60 * 60 * 1000);
	const aligned = await parseSendGridPayload({
		from: "Booking.com <noreply@booking.com>",
		subject: "Reservation confirmation",
		headers: `Date: ${delayedAuthenticatedDate.toUTCString()}`,
		SPF: "pass",
		dkim: "{@unrelated.example : pass}",
		envelope: JSON.stringify({
			from: "bounce@mailer.booking.com",
			to: ["ota@example.com"],
		}),
	});
	assert.equal(aligned.senderAuthentication.authenticatedAligned, true);
	assert.equal(aligned.senderAuthentication.method, "spf");
	assert.equal(
		aligned.sourceReceivedAt.toISOString(),
		new Date(delayedAuthenticatedDate.toUTCString()).toISOString()
	);
	assert.equal(
		aligned.sourceTimestampMethod,
		"authenticated_spf_message_date"
	);
	const alignedNormalized = extractNormalizedReservation(aligned);
	assert.equal(alignedNormalized.sourceSenderTrusted, true);
	assert.equal(alignedNormalized.sourceSenderAuthenticated, true);

	const unaligned = await parseSendGridPayload({
		from: "Booking.com <noreply@booking.com>",
		subject: "Reservation cancellation",
		SPF: "pass",
		dkim: "{@unrelated.example : pass}",
		envelope: JSON.stringify({
			from: "attacker@example.com",
			to: ["ota@example.com"],
		}),
	});
	assert.equal(unaligned.senderAuthentication.authenticatedAligned, false);
	assert.equal(
		unaligned.senderAuthentication.reason,
		"sender_authentication_not_aligned"
	);
});

test("SendGrid DKIM authentication requires an aligned passing signing domain", async () => {
	const aligned = await parseSendGridPayload({
		from: "Trip.com <ebooking@notify.trip.com>",
		SPF: "fail",
		dkim: "{@trip.com : pass} {@sendgrid.net : pass}",
		envelope: JSON.stringify({ from: "attacker@example.com", to: [] }),
	});
	assert.equal(aligned.senderAuthentication.authenticatedAligned, true);
	assert.equal(aligned.senderAuthentication.method, "dkim");
	assert.deepEqual(aligned.senderAuthentication.alignedDkimPassDomains, [
		"trip.com",
	]);

	const copiedHeaderOnly = await parseSendGridPayload({
		from: "Trip.com <ebooking@trip.com>",
		headers:
			"Authentication-Results: attacker.invalid; dkim=pass header.d=trip.com; spf=pass",
		envelope: JSON.stringify({ from: "attacker@example.com", to: [] }),
	});
	assert.equal(
		copiedHeaderOnly.senderAuthentication.authenticatedAligned,
		false
	);
	assert.equal(
		copiedHeaderOnly.senderAuthentication.reason,
		"missing_sender_authentication"
	);
});

test("controller authentication verdict reaches extraction and blocks forged lifecycle mutation", async () => {
	const parsed = await parseSendGridPayload({
		from: "Booking.com <noreply@booking.com>",
		subject: "Reservation cancelled",
		text: [
			"Booking.com",
			"Reservation ID: 12345678",
			"This reservation has been cancelled.",
		].join("\n"),
		SPF: "pass",
		dkim: "{@attacker.example : pass}",
		envelope: JSON.stringify({ from: "attacker@example.com", to: [] }),
	});
	const normalized = extractNormalizedReservation(parsed);
	assert.equal(normalized.provider, "booking");
	assert.equal(normalized.sourceSenderTrusted, true);
	assert.equal(normalized.sourceSenderAuthenticated, false);
	const reconciliation = await reconcileOtaReservation(normalized);
	assert.equal(reconciliation.status, "needs_review");
	assert.equal(reconciliation.actionTaken, "skipped");
	assert.equal(
		reconciliation.skipReason,
		"unauthenticated_ota_sender_no_mutation"
	);
});

test("authenticated MIME Date reaches the lifecycle watermark and rejects older events", async () => {
	const parsed = await parseSendGridPayload({
		from: "Booking.com <noreply@booking.com>",
		subject: "Reservation 12345678 cancelled",
		text: "This reservation has been cancelled.",
		headers: "Date: Tue, 04 Aug 2026 10:00:00 +0000",
		SPF: "fail",
		dkim: "{@booking.com : pass}",
		envelope: JSON.stringify({ from: "attacker@example.com", to: [] }),
	});
	assert.equal(
		parsed.sourceReceivedAt.toISOString(),
		"2026-08-04T10:00:00.000Z"
	);
	assert.equal(
		parsed.sourceTimestampMethod,
		"authenticated_dkim_message_date"
	);
	const normalized = extractNormalizedReservation(parsed);
	assert.equal(normalized.source.receivedAt.toISOString(), "2026-08-04T10:00:00.000Z");
	assert.equal(
		isStaleOtaLifecycleEvent(normalized, {
			supplierData: { otaLastSourceReceivedAt: "2026-08-04T11:00:00.000Z" },
		}),
		true
	);
});
