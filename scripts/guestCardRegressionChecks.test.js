/** @format */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const {
  buildGuestCardData,
  buildPaymentStatus,
  calculateNights,
  renderGuestCardDocument,
  safeAttachmentName,
} = require("../services/guestCard");
const {
  SerializedGuestCardPdfQueue,
  GuestCardPdfBusyError,
} = require("../services/guestCardPdf");
const {
  GUEST_CARD_JSON_LIMIT,
  guestCardJsonParser,
} = require("../services/guestCardJsonParser");
const {
  _guestCardControllerTestables,
  emailAdminGuestCard,
  getAdminGuestCard,
} = require("../controllers/guestCard");

const createResponse = () => {
  const response = {
    headers: {},
    statusCode: 200,
    body: null,
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  return response;
};

const fixture = () => ({
  _id: "64b74714fb50e159d48c714d",
  confirmation_number: "6116125761",
  pms_number: "HMREF3NWRJ",
  customer_details: {
    name: "Abdulrhman Abdulhilme",
    email: "Guest@Example.com",
    cardNumber: "must-never-appear",
  },
  checkin_date: "2026-07-14T00:00:00.000Z",
  checkout_date: "2026-07-16T00:00:00.000Z",
  booked_at: "2026-07-14T09:30:00.000Z",
  total_guests: 3,
  total_amount: 1200,
  paid_amount: 1200,
  pickedRoomsType: [
    {
      room_type: "quadrupleRooms",
      displayName: "Comfort Quadruple Room",
      count: 1,
    },
  ],
});

const hotel = {
  hotelName: "zad ajyad hotel",
  hotelName_OtherLanguage: "فندق زاد أجياد",
  roomCountDetails: [
    {
      roomType: "quadrupleRooms",
      displayName: "Comfort Quadruple Room, City View",
      displayName_OtherLanguage: "غرفة رباعي",
    },
  ],
};

test("builds a canonical bilingual card with a Code 128 image", () => {
  const card = buildGuestCardData(fixture(), hotel);
  assert.equal(card.confirmationNumber, "6116125761");
  assert.equal(card.bookingReference, "6116125761 / HMREF3NWRJ");
  assert.equal(card.hotelNameEnglish, "Zad Ajyad Hotel");
  assert.equal(card.hotelNameArabic, "فندق زاد أجياد");
  assert.equal(card.roomTypeEnglish, "Comfort Quadruple Room");
  assert.equal(card.roomTypeArabic, "غرفة رباعي");
  assert.equal(card.nights, 2);
  assert.equal(card.guests, 3);
  assert.equal(card.paymentStatus.key, "paid");
  assert.match(card.barcodeDataUri, /^data:image\/svg\+xml;base64,/);
});

test("escapes every dynamic field and excludes sensitive source fields", () => {
  const reservation = fixture();
  reservation.customer_details.name = '<img src=x onerror="alert(1)">';
  const html = renderGuestCardDocument(buildGuestCardData(reservation, hotel));
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.doesNotMatch(html, /must-never-appear/);
});

test("handles date-only nights without a server timezone shift", () => {
  assert.equal(calculateNights("2026-07-14", "2026-07-16", 99), 2);
  assert.equal(calculateNights("invalid", "invalid", 4), 4);
});

test("does not label a partial or unpaid reservation as paid", () => {
  assert.equal(
    buildPaymentStatus({ total_amount: 1000, paid_amount: 500 }).key,
    "partial"
  );
  assert.equal(
    buildPaymentStatus({ total_amount: 1000, paid_amount: 0 }).key,
    "unpaid"
  );
  assert.equal(buildPaymentStatus({ total_amount: 0 }).key, "no_due");
});

test("does not present an uncaptured authorization as paid", () => {
  assert.equal(
    buildPaymentStatus({
      total_amount: 1200,
      paid_amount: 1200,
      financeStatus: "authorized",
      payment_details: { captured: false },
    }).key,
    "authorized"
  );
  assert.equal(
    buildPaymentStatus({
      total_amount: 1200,
      paid_amount: 1200,
      financeStatus: "authorized",
      payment_details: { captured: true },
      paypal_details: { captured_total_sar: 400 },
    }).key,
    "partial"
  );
  assert.equal(
    buildPaymentStatus({
      total_amount: 1200,
      paid_amount: 1600,
      payment: "deposit paid",
      financeStatus: "authorized",
      payment_details: { captured: true },
    }).key,
    "captured_pending"
  );
  assert.equal(
    buildPaymentStatus({
      total_amount: 1200,
      paid_amount: 1200,
      financeStatus: "paid",
      payment_details: { captured: true },
    }).key,
    "paid"
  );
  assert.equal(
    buildPaymentStatus({
      total_amount: 1200,
      paid_amount: 0,
      payment: "paid online",
      financeStatus: "paid",
    }).key,
    "captured_pending"
  );
});

test("validates a single recipient and rejects recipient-list injection", () => {
  const { normalizeRecipientEmail } = _guestCardControllerTestables;
  assert.equal(
    normalizeRecipientEmail(" Guest@Example.com "),
    "guest@example.com"
  );
  assert.equal(normalizeRecipientEmail("a@example.com,b@example.com"), "");
  assert.equal(
    normalizeRecipientEmail("a@example.com\r\nBcc:x@example.com"),
    ""
  );
});

test("builds one-recipient SendGrid mail with one PDF attachment", () => {
  const card = buildGuestCardData(fixture(), hotel);
  const message = _guestCardControllerTestables.buildGuestCardEmailMessage({
    recipientEmail: "guest@example.com",
    card,
    pdf: Buffer.from("%PDF-test"),
  });
  assert.equal(message.to, "guest@example.com");
  assert.equal(Object.hasOwn(message, "cc"), false);
  assert.equal(Object.hasOwn(message, "bcc"), false);
  assert.equal(message.from.name, "Jannat Booking");
  assert.match(message.subject, /6116125761/);
  assert.equal(message.attachments.length, 1);
  assert.equal(message.attachments[0].type, "application/pdf");
  assert.equal(message.attachments[0].disposition, "attachment");
  assert.equal(
    Buffer.from(message.attachments[0].content, "base64").toString(),
    "%PDF-test"
  );
  assert.equal(
    _guestCardControllerTestables.guestCardMail.client.defaultRequest.timeout,
    45_000
  );
});

test("rejects forged email fields before database or PDF work", async () => {
  const response = createResponse();
  await emailAdminGuestCard(
    {
      body: {
        recipientEmail: "guest@example.com",
        bcc: "attacker@example.com",
      },
      params: { reservationId: "64b74714fb50e159d48c714d" },
      auth: { _id: "64b74714fb50e159d48c714e" },
    },
    response
  );
  assert.equal(response.statusCode, 400);
  assert.match(response.body.error, /only one recipientEmail/i);
});

test("invalid reservation ids fail closed with no-store headers", async () => {
  const response = createResponse();
  await getAdminGuestCard(
    { params: { reservationId: "not-an-object-id" }, profile: {} },
    response
  );
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.success, false);
  assert.match(response.headers["Cache-Control"], /no-store/);
});

test("admin routes keep authentication, actor matching, and feature access ahead of handlers", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "routes", "janat.js"),
    "utf8"
  );
  for (const [method, routePath, handler] of [
    [
      "get",
      "/admin/reservations/:reservationId/guest-card/:userId",
      "getAdminGuestCard",
    ],
    [
      "post",
      "/admin/reservations/:reservationId/guest-card/email/:userId",
      "emailAdminGuestCard",
    ],
  ]) {
    const blockPattern = new RegExp(
      `router\\.${method}\\(\\s*"${routePath.replace(
        /\//g,
        "\\/"
      )}"\\s*,\\s*requireSignin\\s*,\\s*isAuth\\s*,\\s*requireAdminAccess\\("HotelsReservations",\\s*"AllReservations"\\)\\s*,\\s*${handler}\\s*\\)`,
      "m"
    );
    assert.match(source, blockPattern);
  }
});

test("scopes platform employees even when role 1000 is in the roles array", () => {
  const reservationId = "64b74714fb50e159d48c714d";
  const hotelId = "64b74714fb50e159d48c7150";
  const filter = _guestCardControllerTestables.reservationFilterForActor(
    reservationId,
    { role: 2000, roles: [1000], hotelIdsWork: [hotelId] }
  );
  assert.equal(filter._id, reservationId);
  assert.equal(filter.hotelId.$in.length, 1);
  assert.equal(String(filter.hotelId.$in[0]), hotelId);
});

test("rate limits repeated email attempts per employee", () => {
  const { consumeSendAttempt } = _guestCardControllerTestables;
  const actorId = `rate-test-${Date.now()}`;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal(consumeSendAttempt(actorId, 100_000).allowed, true);
  }
  const blocked = consumeSendAttempt(actorId, 100_000);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfter, 60);
  assert.equal(consumeSendAttempt(actorId, 160_001).allowed, true);
});

test("detects a disconnected client after the request body was received", () => {
  const { requestWasCancelled } = _guestCardControllerTestables;
  assert.equal(requestWasCancelled({}, {}), false);
  assert.equal(requestWasCancelled({ aborted: true }, {}), true);
  assert.equal(
    requestWasCancelled(
      { destroyed: true, complete: true, socket: { destroyed: false } },
      { destroyed: false }
    ),
    false
  );
  assert.equal(requestWasCancelled({}, { destroyed: true }), true);
  assert.equal(requestWasCancelled({ socket: { destroyed: true } }, {}), true);
});

test("parses Guest Card email with a small route-specific limit", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "server.js"),
    "utf8"
  );
  const guestCardParser = source.indexOf("guest-card\\/email");
  const smallParser = source.indexOf("guestCardJsonParser", guestCardParser);
  const legacyLimit = source.indexOf('express.json({ limit: "50mb"');
  assert.ok(guestCardParser >= 0);
  assert.ok(smallParser > guestCardParser);
  assert.ok(legacyLimit > smallParser);
  assert.equal(GUEST_CARD_JSON_LIMIT, "4kb");
});

test("returns JSON 413 for an oversized Guest Card email body", async () => {
  const app = express();
  app.post("/guest-card", guestCardJsonParser, (_req, res) =>
    res.status(204).end()
  );
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/guest-card`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipientEmail: "a".repeat(5_000) }),
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).code, "GUEST_CARD_REQUEST_TOO_LARGE");
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});

test("creates a filesystem-safe attachment name", () => {
  assert.equal(
    safeAttachmentName("AB/123 : test"),
    "Jannat_Guest_Card_AB-123-test.pdf"
  );
});

test("serialized queue recovers after rejection and enforces its cap", async () => {
  const queue = new SerializedGuestCardPdfQueue({
    maxQueued: 1,
    maxWaitMs: 1_000,
  });
  let release;
  const blocker = new Promise((resolve) => {
    release = resolve;
  });
  const first = queue.run(async () => {
    await blocker;
    throw new Error("expected failure");
  });
  const second = queue.run(async () => "second");
  await assert.rejects(
    queue.run(async () => "third"),
    (error) => error instanceof GuestCardPdfBusyError
  );
  release();
  await assert.rejects(first, /expected failure/);
  assert.equal(await second, "second");
  assert.deepEqual(queue.getStats(), { active: 0, queued: 0 });
});
