/** @format */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const InboundEmail = require("../models/inbound_email");
const {
  DEFAULT_AIRBNB_OTA_WHATSAPP_RECIPIENTS,
  MAX_SUMMARY_LENGTH,
  airbnbEventLabel,
  buildAirbnbOtaWhatsappSummary,
  classifyRelevantAirbnbOtaEvent,
  getAirbnbOtaWhatsappRecipients,
  notifyAirbnbOtaInboundWhatsapp,
} = require("./airbnbOtaWhatsappNotifier");

const savedAirbnbRecord = (overrides = {}) => ({
  _id: "inbound-airbnb-1",
  provider: "airbnb",
  processingStatus: "created",
  subject: "Reservation confirmed - Guest arrives Aug 10",
  ...overrides,
});

const successfulDependencies = (sent, persisted = []) => ({
  sendNotification: async (payload) => {
    sent.push(payload);
    return {
      sid: `SM-test-${sent.length}`,
      status: "queued",
      to: payload.toE164,
    };
  },
  persistAudit: async ({ inboundEmailId, audit }) => {
    persisted.push({ inboundEmailId, audit });
    return {
      _id: inboundEmailId,
      provider: "airbnb",
      airbnbWhatsappNotification: audit,
    };
  },
  now: () => new Date("2026-08-04T12:00:00.000Z"),
});

test("new Airbnb reservations notify both exact US recipients and persist delivery audit", async () => {
  const sent = [];
  const persisted = [];
  const result = await notifyAirbnbOtaInboundWhatsapp(
    {
      inboundRecord: savedAirbnbRecord(),
      email: { subject: "Reservation confirmed - Guest arrives Aug 10" },
      normalized: {
        provider: "airbnb",
        intent: "new_reservation",
        eventType: "new",
        confirmationNumber: "hm123abc",
        hotelName: "Zad Ajyad",
        checkinDate: "2026-08-10",
        checkoutDate: "2026-08-12",
      },
      reconciliation: { status: "created" },
    },
    successfulDependencies(sent, persisted)
  );

  assert.deepEqual(
    sent.map((item) => item.toE164),
    DEFAULT_AIRBNB_OTA_WHATSAPP_RECIPIENTS
  );
  assert.equal(
    sent.every((item) => item.recipientName === "Jannat Admin"),
    true
  );
  assert.match(result.message, /^New reservation \| Ref HM123ABC/);
  assert.match(result.message, /Zad Ajyad/);
  assert.equal(result.status, "submitted");
  assert.equal(result.submittedCount, 2);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].inboundEmailId, "inbound-airbnb-1");
  assert.equal(persisted[0].audit.status, "submitted");
  assert.equal(persisted[0].audit.deliveries.length, 2);
  assert.equal(
    persisted[0].audit.deliveries.every((item) => item.status === "submitted"),
    true
  );
});

test("Airbnb updates, cancellations, messages, and review subjects get honest labels", () => {
  const cases = [
    {
      normalized: {
        provider: "airbnb",
        intent: "reservation_update",
        eventType: "modified",
        confirmationNumber: "hmupdate123",
      },
      subject: "Your reservation was modified",
      expected: "Reservation update",
    },
    {
      normalized: {
        provider: "airbnb",
        intent: "reservation_status",
        statusToApply: "cancelled",
        confirmationNumber: "hmcancel123",
      },
      subject: "Reservation cancelled",
      expected: "Reservation cancelled",
    },
    {
      normalized: {
        provider: "airbnb",
        intent: "not_reservation",
        communicationClassification: { reason: "airbnb_guest_message" },
      },
      subject: "You have a new message from your guest",
      expected: "Guest message",
    },
    {
      normalized: {
        provider: "airbnb",
        intent: "unknown",
        eventType: "unknown",
      },
      subject: "Your guest left you a 5-star rating and review",
      expected: "Guest review/rating",
    },
    {
      normalized: {
        provider: "airbnb",
        intent: "unknown",
        eventType: "unknown",
      },
      subject: "Review your reservation details",
      expected: "New OTA email",
    },
  ];

  for (const item of cases) {
    assert.equal(
      airbnbEventLabel({
        inboundRecord: savedAirbnbRecord({ subject: item.subject }),
        email: { subject: item.subject },
        normalized: item.normalized,
        reconciliation: { status: "processed" },
      }),
      item.expected,
      item.subject
    );
  }
});

test("every supported Airbnb reservation lifecycle status is eligible", () => {
  const cases = [
    ["cancelled", "Reservation cancelled"],
    ["no_show", "Reservation no-show"],
    ["confirmed", "Reservation status update"],
    ["inhouse", "Reservation status update"],
    ["checked_out", "Reservation status update"],
  ];

  for (const [statusToApply, expectedLabel] of cases) {
    const decision = classifyRelevantAirbnbOtaEvent({
      inboundRecord: savedAirbnbRecord(),
      normalized: {
        provider: "airbnb",
        intent: "reservation_status",
        statusToApply,
        confirmationNumber: "hmstatus123",
      },
      reconciliation: { status: "needs_review" },
    });

    assert.equal(decision.eligible, true, statusToApply);
    assert.equal(decision.kind, "reservation_update", statusToApply);
    assert.equal(decision.label, expectedLabel, statusToApply);
  }
});

test("realistic Airbnb guest review and rating subjects are eligible", () => {
  for (const subject of [
    "You have a new review",
    "Maria wrote you a review",
    "Read Maria's review",
    "Read Maria’s review",
    "Maria left you a review",
    "You received a new guest rating",
    "Your guest gave you 5 stars",
    "Your guest rated you 5 stars",
    "Maria gave you 5 stars",
    "Maria rated you 5 stars",
    "Your guest rated their stay 5 stars",
    "Maria left you a 5-star review",
    "Maria gave you a 5-star review",
    "New 5-star review from Maria",
    "You received a new 5-star review",
    "Maria rated your stay 5 stars",
    "Maria gave your listing 5 stars",
    "New guest review from Maria",
    "Airbnb: New review for your listing",
    "Your listing received a new review",
  ]) {
    const decision = classifyRelevantAirbnbOtaEvent({
      inboundRecord: savedAirbnbRecord({ subject }),
      email: { subject },
      normalized: { provider: "airbnb", intent: "not_reservation" },
      reconciliation: { status: "not_reservation" },
    });

    assert.equal(decision.eligible, true, subject);
    assert.equal(decision.kind, "review_rating", subject);
  }
});

test("Airbnb rating emails notify even when they are not reservation mutations", async () => {
  const sent = [];
  const result = await notifyAirbnbOtaInboundWhatsapp(
    {
      inboundRecord: savedAirbnbRecord({
        processingStatus: "not_reservation",
        subject: "Your guest left you a review",
      }),
      email: { subject: "Your guest left you a review" },
      normalized: {
        provider: "airbnb",
        intent: "not_reservation",
        eventType: "unknown",
      },
      reconciliation: { status: "not_reservation" },
    },
    successfulDependencies(sent)
  );

  assert.equal(sent.length, 2);
  assert.match(result.message, /^Guest review\/rating/);
  assert.equal(result.status, "submitted");
});

test("generic Airbnb account and marketing emails stay silent", async () => {
  for (const subject of [
    "Verify your Airbnb account",
    "Your Airbnb payout is ready",
    "Ideas for improving your listing",
    "Review your reservation details",
    "Review your account settings",
    "Please leave feedback",
    "Guest feedback survey",
    "A message about Airbnb policy",
    "Have a question about your payout?",
  ]) {
    let sends = 0;
    let writes = 0;
    const result = await notifyAirbnbOtaInboundWhatsapp(
      {
        inboundRecord: savedAirbnbRecord({
          processingStatus: "not_reservation",
          subject,
        }),
        email: { from: "automated@airbnb.com", subject },
        normalized: {
          provider: "airbnb",
          intent: "not_reservation",
          eventType: "unknown",
        },
        reconciliation: { status: "not_reservation" },
      },
      {
        sendNotification: async () => {
          sends += 1;
        },
        persistAudit: async () => {
          writes += 1;
        },
      }
    );

    assert.equal(result.status, "not_required", subject);
    assert.equal(result.reason, "unsupported_airbnb_event", subject);
    assert.equal(sends, 0, subject);
    assert.equal(writes, 0, subject);
  }
});

test("generic failed and needs-review Airbnb emails remain silent", async () => {
  for (const status of ["failed", "needs_review", "needs_mapping"]) {
    let sends = 0;
    let writes = 0;
    const result = await notifyAirbnbOtaInboundWhatsapp(
      {
        inboundRecord: savedAirbnbRecord({
          processingStatus: status,
          subject: "Airbnb account notice",
        }),
        email: {
          from: "automated@airbnb.com",
          subject: "Airbnb account notice",
        },
        normalized: {
          provider: "airbnb",
          intent: "unknown",
          eventType: "unknown",
        },
        reconciliation: { status },
      },
      {
        sendNotification: async () => {
          sends += 1;
        },
        persistAudit: async () => {
          writes += 1;
        },
      }
    );

    assert.equal(result.reason, "unsupported_airbnb_event", status);
    assert.equal(sends, 0, status);
    assert.equal(writes, 0, status);
  }
});

test("review requests, policy reviews, and incidental feedback stay silent", async () => {
  for (const subject of [
    "You received a review request",
    "We received a new review of your appeal",
    "Your guest left their phone in the room - feedback needed",
    "Your guest wrote: please review your cancellation policy",
    "New rating system for Airbnb listings",
    "New review policy for hosts",
    "You have a new review policy update",
    "You received a new rating system update",
    "New review tools are available",
    "Give Maria 5 stars",
    "Read Airbnb's review standards",
    "Read our team's review of your listing",
    "You received a new review from Airbnb Support",
    "New review from the Airbnb team",
    "You got a new rating from Airbnb",
  ]) {
    let sends = 0;
    let writes = 0;
    const result = await notifyAirbnbOtaInboundWhatsapp(
      {
        inboundRecord: savedAirbnbRecord({
          processingStatus: "not_reservation",
          subject,
        }),
        email: { from: "automated@airbnb.com", subject },
        normalized: { provider: "airbnb", intent: "not_reservation" },
        reconciliation: { status: "not_reservation" },
      },
      {
        sendNotification: async () => {
          sends += 1;
        },
        persistAudit: async () => {
          writes += 1;
        },
      }
    );

    assert.equal(result.reason, "unsupported_airbnb_event", subject);
    assert.equal(sends, 0, subject);
    assert.equal(writes, 0, subject);
  }
});

test("intent-only reservation events require a reliable reservation identity", async () => {
  for (const item of [
    {
      subject: "We've updated our reservation policies",
      intent: "reservation_update",
      eventType: "modified",
    },
    {
      subject: "Airbnb reservation status policy update",
      intent: "reservation_status",
      eventType: "status",
      statusToApply: "confirmed",
    },
    {
      subject: "New reservation hosting tips",
      intent: "new_reservation",
      eventType: "new",
    },
  ]) {
    let sends = 0;
    const result = await notifyAirbnbOtaInboundWhatsapp(
      {
        inboundRecord: savedAirbnbRecord({
          processingStatus: "needs_review",
          subject: item.subject,
          confirmationNumber: "",
        }),
        email: { from: "automated@airbnb.com", subject: item.subject },
        normalized: { provider: "airbnb", ...item, confirmationNumber: "" },
        reconciliation: { status: "needs_review" },
      },
      {
        sendNotification: async () => {
          sends += 1;
        },
      }
    );

    assert.equal(result.reason, "unsupported_airbnb_event", item.subject);
    assert.equal(sends, 0, item.subject);
  }
});

test("weak identities stay silent while a valid persisted Airbnb identity remains usable", () => {
  for (const confirmationNumber of [
    "unknown",
    "booking",
    "details",
    "airbnb",
    "confirmed",
  ]) {
    const decision = classifyRelevantAirbnbOtaEvent({
      inboundRecord: savedAirbnbRecord({ confirmationNumber }),
      normalized: {
        provider: "airbnb",
        intent: "reservation_update",
        confirmationNumber,
      },
      reconciliation: { status: "needs_review" },
    });
    assert.equal(decision.eligible, false, confirmationNumber);
  }

  const persistedDecision = classifyRelevantAirbnbOtaEvent({
    inboundRecord: savedAirbnbRecord({
      confirmationNumber: "hm12345678",
      normalizedReservation: {
        provider: "airbnb",
        intent: "new_reservation",
        confirmationNumber: "hm12345678",
      },
    }),
    normalized: {
      provider: "airbnb",
      intent: "unknown",
      confirmationNumber: "unknown",
    },
    reconciliation: { status: "needs_mapping" },
  });
  assert.equal(persistedDecision.eligible, true);
  assert.equal(persistedDecision.kind, "new_reservation");
});

test("the exact terminal Airbnb guest-message shape is eligible", async () => {
  const sent = [];
  const normalized = {
    provider: "airbnb",
    intent: "not_reservation",
    eventType: "unknown",
    terminalNonReservation: true,
    suppressForwarding: true,
    skipReason: "airbnb_guest_message",
    communicationClassification: {
      matched: true,
      isGuestCommunication: true,
      terminalNonReservation: true,
      suppressForwarding: true,
      classification: "guest_communication",
      reason: "airbnb_guest_message",
      provider: "airbnb",
    },
  };
  const result = await notifyAirbnbOtaInboundWhatsapp(
    {
      inboundRecord: savedAirbnbRecord({ processingStatus: "not_reservation" }),
      email: { subject: "You have a new message from your guest" },
      normalized,
      reconciliation: {
        status: "not_reservation",
        actionTaken: "skipped",
        skipReason: "airbnb_guest_message",
      },
    },
    successfulDependencies(sent)
  );

  assert.equal(result.status, "submitted");
  assert.equal(sent.length, 2);
  assert.match(result.message, /^Guest message/);
});

test("Airbnb provider support messages are not mistaken for guest messages", async () => {
  for (const subject of [
    "You have a new message from Airbnb Support",
    "New message from the Airbnb team",
    "Airbnb Support sent you a message",
    "Airbnb Customer Support sent you a message",
    "Your Airbnb Support Ambassador sent you a message",
    "Airbnb Resolution Center wrote you a message",
    "Airbnb Safety team sent you a message",
    "Airbnb Community Support sent you a message",
    "Airbnb Customer Service wrote you a message",
    "Airbnb Claims team sent you a message",
    "Airbnb case manager sent you a message",
    "Airbnb's support team sent you a message",
  ]) {
    let sends = 0;
    let writes = 0;
    const result = await notifyAirbnbOtaInboundWhatsapp(
      {
        inboundRecord: savedAirbnbRecord({
          processingStatus: "not_reservation",
          subject,
        }),
        email: { from: "automated@airbnb.com", subject },
        normalized: {
          provider: "airbnb",
          intent: "not_reservation",
          skipReason: "airbnb_guest_message",
          communicationClassification: {
            reason: "airbnb_guest_message",
          },
        },
        reconciliation: {
          status: "not_reservation",
          skipReason: "airbnb_guest_message",
        },
      },
      {
        sendNotification: async () => {
          sends += 1;
        },
        persistAudit: async () => {
          writes += 1;
        },
      }
    );

    assert.equal(result.reason, "unsupported_airbnb_event", subject);
    assert.equal(sends, 0, subject);
    assert.equal(writes, 0, subject);
  }
});

test("persisted guest-message classification is enough after normalization", async () => {
  const sent = [];
  const result = await notifyAirbnbOtaInboundWhatsapp(
    {
      inboundRecord: savedAirbnbRecord({
        processingStatus: "not_reservation",
        skipReason: "airbnb_guest_message",
        normalizedReservation: {
          provider: "airbnb",
          intent: "not_reservation",
          communicationClassification: {
            reason: "airbnb_guest_message",
          },
        },
      }),
      email: { subject: "Airbnb notification" },
      normalized: {},
      reconciliation: { status: "not_reservation" },
    },
    successfulDependencies(sent)
  );

  assert.equal(result.status, "submitted");
  assert.equal(sent.length, 2);
  assert.match(result.message, /^Guest message/);
});

test("reconciliation guest-message reason is enough when normalized data is sparse", async () => {
  const sent = [];
  const result = await notifyAirbnbOtaInboundWhatsapp(
    {
      inboundRecord: savedAirbnbRecord({ processingStatus: "not_reservation" }),
      email: {
        from: "automated@airbnb.com",
        subject: "Airbnb notification",
      },
      normalized: { provider: "airbnb", intent: "not_reservation" },
      reconciliation: {
        status: "not_reservation",
        skipReason: "airbnb_guest_message",
      },
    },
    successfulDependencies(sent)
  );

  assert.equal(result.status, "submitted");
  assert.equal(sent.length, 2);
  assert.match(result.message, /^Guest message/);
});

test("HotelRunner guest messages notify only with an explicit Airbnb channel marker", async () => {
  for (const sample of [
    {
      text: "Guest sent you a direct message\nChannel: AIRBNB\nWrite a reply",
      expectedSends: 2,
      expectedReason: "airbnb_guest_message_via_hotelrunner",
    },
    {
      text: "Guest sent you a direct message\nWrite a reply",
      expectedSends: 0,
      expectedReason: "not_airbnb",
    },
  ]) {
    const sent = [];
    const result = await notifyAirbnbOtaInboundWhatsapp(
      {
        inboundRecord: {
          _id: "inbound-hotelrunner-message",
          provider: "hotelrunner",
          processingStatus: "not_reservation",
        },
        email: {
          from: "noreply@hotelrunner.com",
          subject: "You have a message!",
          text: sample.text,
        },
        normalized: {
          provider: "hotelrunner",
          intent: "not_reservation",
          skipReason: "hotelrunner_guest_message",
          communicationClassification: {
            reason: "hotelrunner_guest_message",
          },
        },
        reconciliation: {
          status: "not_reservation",
          skipReason: "hotelrunner_guest_message",
        },
      },
      successfulDependencies(sent)
    );

    assert.equal(sent.length, sample.expectedSends, sample.text);
    assert.equal(
      result.reason || "airbnb_guest_message_via_hotelrunner",
      sample.expectedReason,
      sample.text
    );
  }
});

test("eligible reservation intent still notifies when processing needs review", async () => {
  const sent = [];
  const result = await notifyAirbnbOtaInboundWhatsapp(
    {
      inboundRecord: savedAirbnbRecord({ processingStatus: "needs_mapping" }),
      email: { subject: "Reservation confirmed" },
      normalized: {
        provider: "airbnb",
        intent: "new_reservation",
        eventType: "unknown",
        confirmationNumber: "hm-needs-mapping",
      },
      reconciliation: { status: "needs_mapping" },
    },
    successfulDependencies(sent)
  );

  assert.equal(result.status, "submitted");
  assert.equal(sent.length, 2);
  assert.match(result.message, /^New reservation/);
  assert.match(result.message, /Status needs mapping/);
});

test("non-Airbnb inbound emails do not send or write a WhatsApp audit", async () => {
  let sends = 0;
  let writes = 0;
  const result = await notifyAirbnbOtaInboundWhatsapp(
    {
      inboundRecord: {
        _id: "inbound-booking-1",
        provider: "booking",
        processingStatus: "created",
      },
      email: { from: "noreply@booking.com", subject: "New reservation" },
      normalized: { provider: "booking", intent: "new_reservation" },
    },
    {
      sendNotification: async () => {
        sends += 1;
      },
      persistAudit: async () => {
        writes += 1;
      },
    }
  );

  assert.equal(result.status, "not_required");
  assert.equal(result.reason, "not_airbnb");
  assert.equal(sends, 0);
  assert.equal(writes, 0);
});

test("exact duplicate Airbnb deliveries remain silent", async () => {
  let sends = 0;
  const result = await notifyAirbnbOtaInboundWhatsapp(
    {
      inboundRecord: savedAirbnbRecord({
        processingStatus: "duplicate_email",
        duplicateOf: "original-inbound-id",
      }),
      normalized: { provider: "airbnb", intent: "new_reservation" },
      reconciliation: { status: "duplicate_email" },
    },
    {
      sendNotification: async () => {
        sends += 1;
      },
    }
  );

  assert.equal(result.status, "not_required");
  assert.equal(result.reason, "duplicate_email");
  assert.equal(sends, 0);
});

test("the production recipient list stays limited to the two requested administrators", () => {
  assert.deepEqual(
    getAirbnbOtaWhatsappRecipients("+14155550123"),
    DEFAULT_AIRBNB_OTA_WHATSAPP_RECIPIENTS
  );
});

test("the exported relevance helper never classifies another OTA as Airbnb", () => {
  const decision = classifyRelevantAirbnbOtaEvent({
    inboundRecord: { provider: "booking", subject: "New reservation" },
    email: { from: "noreply@booking.com", subject: "New reservation" },
    normalized: {
      provider: "booking",
      intent: "new_reservation",
      confirmationNumber: "booking123",
    },
    reconciliation: { status: "created" },
  });

  assert.equal(decision.eligible, false);
  assert.equal(decision.reason, "not_airbnb");
});

test("one Twilio failure does not block the other recipient or reject inbound work", async () => {
  const attempted = [];
  let savedAudit = null;
  const result = await notifyAirbnbOtaInboundWhatsapp(
    {
      inboundRecord: savedAirbnbRecord(),
      email: { subject: "Reservation confirmed" },
      normalized: {
        provider: "airbnb",
        intent: "new_reservation",
        confirmationNumber: "hm-failure-test",
      },
      reconciliation: { status: "created" },
    },
    {
      sendNotification: async ({ toE164 }) => {
        attempted.push(toE164);
        if (toE164 === DEFAULT_AIRBNB_OTA_WHATSAPP_RECIPIENTS[0]) {
          const error = new Error("simulated Twilio outage");
          error.code = 20500;
          error.status = 503;
          throw error;
        }
        return { sid: "SM-second-recipient", status: "queued" };
      },
      persistAudit: async ({ audit }) => {
        savedAudit = audit;
        return null;
      },
    }
  );

  assert.deepEqual(attempted, DEFAULT_AIRBNB_OTA_WHATSAPP_RECIPIENTS);
  assert.equal(result.status, "partial");
  assert.equal(result.submittedCount, 1);
  assert.equal(result.failedCount, 1);
  assert.equal(savedAudit.status, "partial");
  assert.match(
    savedAudit.deliveries[0].error,
    /Twilio 20500: HTTP 503: simulated Twilio outage/
  );
});

test("missing template responses are audited as failed without throwing", async () => {
  const result = await notifyAirbnbOtaInboundWhatsapp(
    {
      inboundRecord: savedAirbnbRecord(),
      normalized: { provider: "airbnb", intent: "new_reservation" },
      reconciliation: { status: "created" },
    },
    {
      sendNotification: async () => ({
        ok: false,
        error: "missing TWILIO_CSID_AIRBNB_OTA_NOTIFICATION",
      }),
      persistAudit: async () => null,
    }
  );

  assert.equal(result.status, "failed");
  assert.equal(result.skippedCount, 0);
  assert.equal(result.failedCount, 2);
});

test("provider-declared failed messages are never counted as submitted", async () => {
  const result = await notifyAirbnbOtaInboundWhatsapp(
    {
      inboundRecord: savedAirbnbRecord(),
      normalized: { provider: "airbnb", intent: "new_reservation" },
      reconciliation: { status: "created" },
    },
    {
      sendNotification: async ({ toE164 }) => ({
        sid: `SM-failed-${toE164.slice(-4)}`,
        status: "failed",
        errorCode: 63016,
        errorMessage: "Template could not be sent",
      }),
      persistAudit: async () => null,
    }
  );

  assert.equal(result.status, "failed");
  assert.equal(result.submittedCount, 0);
  assert.equal(result.failedCount, 2);
  assert.match(
    result.deliveries[0].error,
    /Twilio 63016: Template could not be sent/
  );
});

test("a submission timeout is recorded as unknown, never as a definite failure", async () => {
  let savedAudit = null;
  const result = await notifyAirbnbOtaInboundWhatsapp(
    {
      inboundRecord: savedAirbnbRecord(),
      normalized: {
        provider: "airbnb",
        intent: "new_reservation",
        confirmationNumber: "hmtimeout123",
      },
      reconciliation: { status: "created" },
    },
    {
      recipients: [DEFAULT_AIRBNB_OTA_WHATSAPP_RECIPIENTS[0]],
      sendTimeoutMs: 1000,
      sendNotification: async () => new Promise(() => {}),
      persistAudit: async ({ audit }) => {
        savedAudit = audit;
        return null;
      },
    }
  );

  assert.equal(result.status, "unknown");
  assert.equal(result.failedCount, 0);
  assert.equal(result.unknownCount, 1);
  assert.equal(savedAudit.deliveries[0].status, "unknown");
  assert.match(savedAudit.deliveries[0].error, /result was not known/);
});

test("notification summaries are short and never include email bodies or sensitive fields", () => {
  const summary = buildAirbnbOtaWhatsappSummary({
    inboundRecord: savedAirbnbRecord({
      subject: "Guest message OTP 654321, call 9092223374 or guest@example.com",
    }),
    email: {
      subject: "Guest message OTP 654321, call 9092223374 or guest@example.com",
      text: "OTP 654321 CVV 123 card 4111111111111111 private body text",
      html: "<p>private html body</p>",
    },
    normalized: {
      provider: "airbnb",
      intent: "not_reservation",
      checkinDate: "2026-08-10",
      checkoutDate: "2026-08-12",
      guestNotes: "private guest message",
      paymentInstructions: "card 4111111111111111",
    },
    reconciliation: { status: "not_reservation" },
  });

  assert.ok(summary.length <= MAX_SUMMARY_LENGTH);
  assert.doesNotMatch(
    summary,
    /654321|9092223374|guest@example\.com|4111111111111111|private body|private html|private guest/i
  );
  assert.match(summary, /\[redacted\]|\[phone redacted\]|\[email redacted\]/);
  assert.match(summary, /Stay 2026-08-10 to 2026-08-12/);
});

test("inbound email schema stores the Airbnb WhatsApp delivery audit", () => {
  assert.ok(InboundEmail.schema.path("airbnbWhatsappNotification.status"));
  assert.ok(InboundEmail.schema.path("airbnbWhatsappNotification.deliveries"));
  assert.ok(InboundEmail.schema.path("airbnbWhatsappNotification.attemptedAt"));
});
