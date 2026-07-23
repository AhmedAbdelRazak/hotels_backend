/** @format */

const assert = require("node:assert/strict");
const test = require("node:test");

const {
	INBOUND_CLAIM_LEASE_MS,
	buildInboundDedupeKey,
	canonicalizeInboundEmailContent,
	isReclaimableInboundClaim,
	normalizeMessageId,
	shouldRetryInboundCollision,
} = require("./otaInboundDedupe");
const {
	INBOUND_DEDUPE_INDEX_FIELDS,
	INBOUND_DEDUPE_INDEX_OPTIONS,
	createInboundDedupeIndex,
} = require("./otaInboundDedupeIndex");

test("normalizes Message-ID case, brackets, label, and folded whitespace", () => {
	assert.equal(
		normalizeMessageId(" Message-ID: <ABC.Def-123@Example.COM> "),
		"abc.def-123@example.com"
	);
	assert.equal(
		normalizeMessageId("\r\n < abc.def-123@EXAMPLE.com >\t"),
		"abc.def-123@example.com"
	);
});

test("Message-ID is the primary identity even when raw MIME and content differ", () => {
	const first = buildInboundDedupeKey({
		messageId: "<OTA-ABC@mailer.example>",
		rawHash: "first-raw-mime-hash",
		subject: "Original subject",
		text: "Original body",
	});
	const replay = buildInboundDedupeKey({
		messageId: " ota-abc@MAILER.EXAMPLE ",
		rawHash: "different-raw-mime-hash",
		subject: "Changed MIME rendering",
		text: "Changed transport representation",
	});

	assert.match(first, /^mid:[a-f0-9]{64}$/);
	assert.equal(replay, first);
});

test("falls back to canonical content across address, whitespace, HTML, and redaction variations", () => {
	const textDelivery = {
		from: '"OTA Reservations" <NO-REPLY@OTA.EXAMPLE>',
		to: "Front Desk <desk@example.com>, OTA <ota@example.com>",
		subject: "  BOOKING   Confirmation  ",
		text: "Reservation 12345\r\nCard number: 4111 1111 1111 1234",
	};
	const htmlDelivery = {
		from: "no-reply@ota.example",
		to: "ota@example.com; desk@example.com",
		subject: "booking confirmation",
		html: "<p>Reservation&nbsp;12345</p><p>Card number: [REDACTED]</p>",
	};

	const first = buildInboundDedupeKey(textDelivery);
	const replay = buildInboundDedupeKey(htmlDelivery);

	assert.match(first, /^content:[a-f0-9]{64}$/);
	assert.equal(replay, first);
	assert.equal(
		canonicalizeInboundEmailContent(textDelivery),
		canonicalizeInboundEmailContent(htmlDelivery)
	);
});

test("fallback content identity still distinguishes different reservations", () => {
	const base = {
		from: "no-reply@ota.example",
		to: "ota@example.com",
		subject: "Booking confirmation",
		text: "Reservation 12345 is confirmed",
	};
	assert.notEqual(
		buildInboundDedupeKey(base),
		buildInboundDedupeKey({
			...base,
			text: "Reservation 98765 is confirmed",
		})
	);
});

test("fallback identity distinguishes attachment-only messages by content hash", () => {
	const base = {
		from: "no-reply@ota.example",
		to: "ota@example.com",
		subject: "Reservation attachment",
		text: "Please see attached reservation.",
	};
	const first = buildInboundDedupeKey({
		...base,
		attachments: [
			{
				filename: "reservation.pdf",
				contentType: "application/pdf",
				size: 1024,
				contentHash: "a".repeat(64),
			},
		],
	});
	const second = buildInboundDedupeKey({
		...base,
		attachments: [
			{
				filename: "reservation.pdf",
				contentType: "application/pdf",
				size: 1024,
				contentHash: "b".repeat(64),
			},
		],
	});

	assert.notEqual(first, second);
});

test("does not claim a completely empty parse", () => {
	assert.equal(buildInboundDedupeKey({}), "");
});

test("dedupe key index is unique and ignores legacy documents without a key", () => {
	const InboundEmail = require("../models/inbound_email");
	const index = InboundEmail.schema
		.indexes()
		.find(([fields]) => fields.dedupeKey === 1);

	assert.ok(index, "dedupeKey index should be declared");
	const [, options] = index;
	assert.equal(options.unique, true);
	assert.equal(options.name, "uniq_inbound_email_dedupe_key");
	assert.deepEqual(options.partialFilterExpression, {
		dedupeKey: { $type: "string", $gt: "" },
	});
	assert.equal(InboundEmail.schema.path("dedupeKey").defaultValue, undefined);
});

test("startup readiness creates only the inbound dedupe index", async () => {
	const calls = [];
	const collection = {
		createIndex: async (fields, options) => {
			calls.push({ fields, options });
			return options.name;
		},
	};
	const name = await createInboundDedupeIndex(collection);

	assert.equal(name, "uniq_inbound_email_dedupe_key");
	assert.deepEqual(calls, [
		{
			fields: INBOUND_DEDUPE_INDEX_FIELDS,
			options: INBOUND_DEDUPE_INDEX_OPTIONS,
		},
	]);
});

test("only failed or stale in-flight claims can be reclaimed automatically", () => {
	const now = Date.parse("2026-07-23T12:00:00.000Z");
	assert.equal(
		isReclaimableInboundClaim({ processingStatus: "failed" }, { now }),
		true,
	);
	assert.equal(
		isReclaimableInboundClaim(
			{
				processingStatus: "received",
				receivedAt: new Date(now - INBOUND_CLAIM_LEASE_MS - 1),
			},
			{ now },
		),
		true,
	);
	assert.equal(
		isReclaimableInboundClaim(
			{
				processingStatus: "received",
				receivedAt: new Date(now - INBOUND_CLAIM_LEASE_MS + 1),
			},
			{ now },
		),
		false,
	);
	for (const processingStatus of ["needs_review", "needs_mapping", "created"]) {
		assert.equal(
			isReclaimableInboundClaim({ processingStatus }, { now }),
			false,
			processingStatus,
		);
	}
});

test("a fresh atomic in-flight collision asks the sender to retry", () => {
	assert.equal(
		shouldRetryInboundCollision(
			{ processingStatus: "received" },
			"atomic_claim",
		),
		true,
	);
	assert.equal(
		shouldRetryInboundCollision(
			{ processingStatus: "needs_review" },
			"atomic_claim",
		),
		false,
	);
	assert.equal(
		shouldRetryInboundCollision(
			{ processingStatus: "received" },
			"processed_precheck",
		),
		false,
	);
});
