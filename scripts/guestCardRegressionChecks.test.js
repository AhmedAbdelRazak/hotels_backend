/** @format */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const express = require("express");
const puppeteer = require("puppeteer");
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

const CODE128_PATTERNS = [
  "212222",
  "222122",
  "222221",
  "121223",
  "121322",
  "131222",
  "122213",
  "122312",
  "132212",
  "221213",
  "221312",
  "231212",
  "112232",
  "122132",
  "122231",
  "113222",
  "123122",
  "123221",
  "223211",
  "221132",
  "221231",
  "213212",
  "223112",
  "312131",
  "311222",
  "321122",
  "321221",
  "312212",
  "322112",
  "322211",
  "212123",
  "212321",
  "232121",
  "111323",
  "131123",
  "131321",
  "112313",
  "132113",
  "132311",
  "211313",
  "231113",
  "231311",
  "112133",
  "112331",
  "132131",
  "113123",
  "113321",
  "133121",
  "313121",
  "211331",
  "231131",
  "213113",
  "213311",
  "213131",
  "311123",
  "311321",
  "331121",
  "312113",
  "312311",
  "332111",
  "314111",
  "221411",
  "431111",
  "111224",
  "111422",
  "121124",
  "121421",
  "141122",
  "141221",
  "112214",
  "112412",
  "122114",
  "122411",
  "142112",
  "142211",
  "241211",
  "221114",
  "413111",
  "241112",
  "134111",
  "111242",
  "121142",
  "121241",
  "114212",
  "124112",
  "124211",
  "411212",
  "421112",
  "421211",
  "212141",
  "214121",
  "412121",
  "111143",
  "111341",
  "131141",
  "114113",
  "114311",
  "411113",
  "411311",
  "113141",
  "114131",
  "311141",
  "411131",
  "211412",
  "211214",
  "211232",
  "2331112",
];

const greatestCommonDivisor = (left, right) => {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b) [a, b] = [b, a % b];
  return a;
};

const paethPredictor = (left, above, upperLeft) => {
  const prediction = left + above - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const aboveDistance = Math.abs(prediction - above);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance)
    return left;
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
};

const decodePngRows = (png) => {
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  assert.equal(png[24], 8, "barcode PNG must use 8-bit channels");
  assert.equal(png[25], 6, "barcode PNG must use RGBA pixels");
  const idat = [];
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT")
      idat.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const encoded = zlib.inflateSync(Buffer.concat(idat));
  const bytesPerPixel = 4;
  const rowLength = width * bytesPerPixel;
  const rows = [];
  let sourceOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = encoded[sourceOffset++];
    const row = Buffer.alloc(rowLength);
    const previous = rows[y - 1] || Buffer.alloc(rowLength);
    for (let x = 0; x < rowLength; x += 1) {
      const raw = encoded[sourceOffset++];
      const left = x >= bytesPerPixel ? row[x - bytesPerPixel] : 0;
      const above = previous[x];
      const upperLeft = x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0;
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? above
              : filter === 3
                ? Math.floor((left + above) / 2)
                : filter === 4
                  ? paethPredictor(left, above, upperLeft)
                  : Number.NaN;
      assert.ok(Number.isFinite(predictor), `unsupported PNG filter ${filter}`);
      row[x] = (raw + predictor) & 0xff;
    }
    rows.push(row);
  }
  return { height, rows, width };
};

const decodeCode128PngDataUri = (dataUri) => {
  assert.match(dataUri, /^data:image\/png;base64,/);
  const png = Buffer.from(dataUri.split(",", 2)[1], "base64");
  const { height, rows, width } = decodePngRows(png);
  const blackRows = rows.reduce((count, pngRow) => {
    for (let offset = 0; offset < pngRow.length; offset += 4) {
      if (pngRow[offset] + pngRow[offset + 1] + pngRow[offset + 2] < 384) {
        return count + 1;
      }
    }
    return count;
  }, 0);
  const row = rows[Math.floor(height / 2)];
  const colors = Array.from({ length: width }, (_value, x) => {
    const offset = x * 4;
    return row[offset] + row[offset + 1] + row[offset + 2] < 384;
  });
  const runs = [];
  for (const black of colors) {
    const current = runs[runs.length - 1];
    if (current?.black === black) current.width += 1;
    else runs.push({ black, width: 1 });
  }
  assert.equal(runs[0]?.black, false, "left quiet zone is missing");
  assert.equal(runs.at(-1)?.black, false, "right quiet zone is missing");
  const symbolRuns = runs.slice(1, -1).map((run) => run.width);
  const moduleWidth = symbolRuns.reduce(greatestCommonDivisor);
  assert.ok(moduleWidth >= 2, "barcode modules are not raster-safe");
  assert.ok(runs[0].width / moduleWidth >= 10, "left quiet zone is too small");
  assert.ok(
    runs.at(-1).width / moduleWidth >= 10,
    "right quiet zone is too small"
  );
  const normalized = symbolRuns.map((runWidth) => runWidth / moduleWidth);
  assert.ok(normalized.every(Number.isInteger), "barcode bars are distorted");
  const patternToCode = new Map(
    CODE128_PATTERNS.map((pattern, code) => [pattern, code])
  );
  const codewords = [];
  let offset = 0;
  while (normalized.length - offset > 7) {
    const pattern = normalized.slice(offset, offset + 6).join("");
    assert.ok(
      patternToCode.has(pattern),
      `unknown Code 128 pattern ${pattern}`
    );
    codewords.push(patternToCode.get(pattern));
    offset += 6;
  }
  assert.equal(normalized.slice(offset).join(""), CODE128_PATTERNS[106]);
  const checksum = codewords.pop();
  const start = codewords.shift();
  assert.ok(
    [103, 104, 105].includes(start),
    "Code 128 start marker is invalid"
  );
  const expectedChecksum = codewords.reduce(
    (sum, code, index) => sum + code * (index + 1),
    start
  );
  assert.equal(checksum, expectedChecksum % 103, "Code 128 checksum failed");
  let codeSet = start === 103 ? "A" : start === 104 ? "B" : "C";
  let text = "";
  for (const code of codewords) {
    if (code === 102) continue;
    if (code === 99) {
      codeSet = "C";
      continue;
    }
    if (code === 100 && codeSet !== "B") {
      codeSet = "B";
      continue;
    }
    if (code === 101 && codeSet !== "A") {
      codeSet = "A";
      continue;
    }
    if (codeSet === "C" && code <= 99) text += String(code).padStart(2, "0");
    else if (codeSet === "B" && code <= 95)
      text += String.fromCharCode(code + 32);
    else if (codeSet === "A" && code <= 95)
      text += String.fromCharCode(code < 64 ? code + 32 : code - 64);
    else assert.fail(`unsupported Code 128 value ${code} in set ${codeSet}`);
  }
  return { blackRows, height, text, width };
};

test("builds a canonical bilingual card with an exact raster Code 128 image", async () => {
  const card = await buildGuestCardData(fixture(), hotel);
  assert.equal(card.confirmationNumber, "6116125761");
  assert.equal(card.bookingReference, "6116125761 / HMREF3NWRJ");
  assert.equal(card.hotelNameEnglish, "Zad Ajyad Hotel");
  assert.equal(card.hotelNameArabic, "فندق زاد أجياد");
  assert.equal(card.roomTypeEnglish, "Comfort Quadruple Room");
  assert.equal(card.roomTypeArabic, "غرفة رباعي");
  assert.equal(card.nights, 2);
  assert.equal(card.guests, 3);
  assert.equal(card.paymentStatus.key, "paid");
  assert.equal(card.barcodeDisplayWidth, 330);
  const decoded = decodeCode128PngDataUri(card.barcodeDataUri);
  assert.equal(decoded.text, card.confirmationNumber);
  assert.deepEqual(
    { width: decoded.width, height: decoded.height },
    { width: 330, height: 56 }
  );
});

test("keeps alphanumeric confirmation barcodes exact", async () => {
  const reservation = fixture();
  reservation.confirmation_number = "HMREF3NWRJ";
  const card = await buildGuestCardData(reservation, hotel);
  assert.equal(decodeCode128PngDataUri(card.barcodeDataUri).text, "HMREF3NWRJ");
  assert.equal(card.barcodeDisplayWidth, 330);
});

test("keeps variable-width barcodes exact after browser rendering", async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 820, deviceScaleFactor: 2 });
    for (const [confirmationNumber, expectedWidth] of [
      ["383933243", 363],
      ["HMREF3NWRJ", 330],
      ["1234567890123456789012345678901234567890", 275],
    ]) {
      const reservation = fixture();
      reservation.confirmation_number = confirmationNumber;
      const card = await buildGuestCardData(reservation, hotel);
      assert.equal(card.barcodeDisplayWidth, expectedWidth);
      await page.setContent(renderGuestCardDocument(card), {
        waitUntil: "load",
      });
      const barcode = await page.$(".jgc-barcode");
      assert.ok(barcode, "rendered barcode image is missing");
      const screenshot = await barcode.screenshot({ encoding: "binary" });
      const decoded = decodeCode128PngDataUri(
        `data:image/png;base64,${screenshot.toString("base64")}`
      );
      assert.equal(decoded.text, confirmationNumber);
      assert.equal(decoded.width, expectedWidth * 2);
      assert.ok(decoded.blackRows >= 80, "rendered barcode bars are too short");
    }
  } finally {
    await browser.close();
  }
});

test("omits a barcode that cannot fit without corrupting its modules", async () => {
  const reservation = fixture();
  reservation.confirmation_number = "A".repeat(80);
  const card = await buildGuestCardData(reservation, hotel);
  assert.equal(card.confirmationNumber, reservation.confirmation_number);
  assert.equal(card.barcodeDataUri, "");
  assert.equal(card.barcodeDisplayWidth, 0);
  assert.doesNotMatch(renderGuestCardDocument(card), /class="jgc-barcode"/);
});

test("escapes every dynamic field and excludes sensitive source fields", async () => {
  const reservation = fixture();
  reservation.customer_details.name = '<img src=x onerror="alert(1)">';
  const html = renderGuestCardDocument(
    await buildGuestCardData(reservation, hotel)
  );
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

test("builds one-recipient SendGrid mail with one PDF attachment", async () => {
  const card = await buildGuestCardData(fixture(), hotel);
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
