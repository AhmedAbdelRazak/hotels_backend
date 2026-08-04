/** @format */

"use strict";

const DEFAULT_AIRBNB_OTA_WHATSAPP_RECIPIENTS = Object.freeze([
  "+19092223374",
  "+19099914386",
]);
const MAX_SUMMARY_LENGTH = 240;
const DEFAULT_SEND_TIMEOUT_MS = 12000;
const AIRBNB_STATUS_VALUES = new Set([
  "cancelled",
  "canceled",
  "no_show",
  "confirmed",
  "inhouse",
  "checked_out",
]);

const normalizeText = (value = "") =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim();

const uniqueStrings = (values = []) =>
  Array.from(
    new Set(
      values
        .map((value) => normalizeText(value).replace(/^whatsapp:/i, ""))
        .filter(Boolean)
    )
  );

const getAirbnbOtaWhatsappRecipients = () => [
  ...DEFAULT_AIRBNB_OTA_WHATSAPP_RECIPIENTS,
];

const guestCommunicationReasons = ({
  inboundRecord = {},
  normalized = {},
  reconciliation = {},
} = {}) =>
  [
    normalized.communicationClassification?.reason,
    normalized.skipReason,
    inboundRecord.normalizedReservation?.communicationClassification?.reason,
    inboundRecord.normalizedReservation?.skipReason,
    inboundRecord.emailContext?.communicationClassification?.reason,
    inboundRecord.skipReason,
    reconciliation.skipReason,
    inboundRecord.reconciliation?.skipReason,
  ]
    .map((value) => normalizeText(value).toLowerCase())
    .filter(Boolean);

const isAirbnbHotelRunnerGuestMessageRelay = ({
  inboundRecord = {},
  email = {},
  normalized = {},
  reconciliation = {},
} = {}) => {
  const reasons = guestCommunicationReasons({
    inboundRecord,
    normalized,
    reconciliation,
  });
  if (!reasons.includes("hotelrunner_guest_message")) return false;

  const text = [
    email.text,
    email.html,
    inboundRecord.bodyText,
    inboundRecord.bodyHtml,
  ]
    .filter(Boolean)
    .join("\n");
  return /(?:^|[\r\n>])\s*(?:(?:booking\s+)?(?:source|channel|ota)\s*[:=-]?\s*)?airbnb\s*(?=$|[\r\n<])/im.test(
    text
  );
};

const isAirbnbOtaInbound = ({
  inboundRecord = {},
  email = {},
  normalized = {},
  reconciliation = {},
} = {}) => {
  const providers = [
    normalized.provider,
    inboundRecord.provider,
    inboundRecord.normalizedReservation?.provider,
  ]
    .map((value) => normalizeText(value).toLowerCase())
    .filter(Boolean);
  if (providers.includes("airbnb")) return true;
  if (
    isAirbnbHotelRunnerGuestMessageRelay({
      inboundRecord,
      email,
      normalized,
      reconciliation,
    })
  ) {
    return true;
  }

  const senders = [
    email.from,
    normalized.source?.from,
    inboundRecord.from,
    inboundRecord.emailContext?.originalFrom,
    ...(Array.isArray(inboundRecord.emailContext?.fromCandidates)
      ? inboundRecord.emailContext.fromCandidates
      : []),
  ];
  return senders.some((value) =>
    /@(?:[a-z0-9-]+\.)*airbnb\.com\b/i.test(String(value || ""))
  );
};

const isDuplicateInboundDelivery = ({
  inboundRecord = {},
  reconciliation = {},
} = {}) =>
  Boolean(inboundRecord.duplicateOf) ||
  normalizeText(inboundRecord.processingStatus).toLowerCase() ===
    "duplicate_email" ||
  normalizeText(reconciliation.status).toLowerCase() === "duplicate_email";

const redactedSummaryPart = (value = "", maxLength = 100) =>
  normalizeText(value)
    .replace(/https?:\/\/\S+/gi, "[link]")
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, "[email redacted]")
    .replace(
      /\b((?:otp|one[-\s]?time|verification|login|access)(?:\s+(?:code|token))?|password|pin)\s*[:#-]?\s*[a-z0-9-]{4,24}\b/gi,
      "$1 [redacted]"
    )
    .replace(
      /\b(?:cvv|cvc|security code)\s*[:#-]?\s*\d{3,8}\b/gi,
      "security code [redacted]"
    )
    .replace(/\b(?:\d[ -]*?){15,19}\b/g, "[card redacted]")
    .replace(
      /\b(?:passport|national id|identity number)\s*[:#-]?\s*[a-z0-9-]{5,24}\b/gi,
      "identity [redacted]"
    )
    .replace(
      /\b(?:phone|mobile|whatsapp)\s*[:#-]?\s*\+?\d[\d ().-]{7,}\d/gi,
      "phone [redacted]"
    )
    .replace(/\+\d[\d ().-]{7,}\d/g, "[phone redacted]")
    .replace(
      /\b(?:1[ .-]?)?(?:\([2-9]\d{2}\)|[2-9]\d{2})[ .-]?\d{3}[ .-]?\d{4}\b/g,
      "[phone redacted]"
    )
    .slice(0, maxLength);

const firstText = (...values) => values.map(normalizeText).find(Boolean) || "";

const firstMeaningfulText = (...values) =>
  values
    .map(normalizeText)
    .find((value) => value && value.toLowerCase() !== "unknown") || "";

const isReliableAirbnbReservationIdentity = (value = "") => {
  const normalized = normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  if (!normalized) return false;
  return (
    /^hm[a-z0-9]{6,20}$/.test(normalized) ||
    /^\d{6,20}$/.test(normalized) ||
    /^[a-f0-9]{24}$/.test(normalized)
  );
};

const notificationSubject = ({
  inboundRecord = {},
  email = {},
  normalized = {},
} = {}) =>
  firstText(
    inboundRecord.emailContext?.originalSubject,
    normalized.originalSubject,
    email.subject,
    normalized.source?.subject,
    inboundRecord.subject
  );

const isAirbnbGuestReviewOrRatingSubject = (subject = "") => {
  const value = normalizeText(subject);
  if (!value) return false;

  const negativePatterns = [
    /\breview (?:your )?(?:account|settings|listing|performance|reservation details)\b/i,
    /\b(?:review|rating) (?:request|invitation|reminder|system|policy|program|feature|tools?|guide)\b/i,
    /\breview of (?:your )?(?:appeal|case|claim|account)\b/i,
    /\b(?:review|rating) (?:from|by) (?:the )?airbnb(?:\s+(?:community )?(?:support|team))?\b/i,
    /\bplease (?:provide|leave|send) feedback\b/i,
    /\bguest feedback survey\b/i,
    /\bfeedback (?:needed|requested)\b/i,
    /\bperformance review\b/i,
  ];
  if (negativePatterns.some((pattern) => pattern.test(value))) return false;

  const positivePatterns = [
    /\byou have (?:a )?new (?:guest )?(?:review|rating)(?:\s+(?:from|by)\s+.+|\s+for your listing)?[.!]?$/i,
    /\byou (?:received|got) (?:a )?(?:new )?(?:guest )?(?:review|rating)(?:\s+(?:from|by)\s+.+|\s+for your listing)?[.!]?$/i,
    /\byou (?:received|got) (?:a )?(?:new )?[1-5](?:\.\d)?[- ]star (?:review|rating)[.!]?$/i,
    /^(?:airbnb:\s*)?new (?:guest )?(?:review|rating)(?:\s+(?:from|by)\s+.+|\s+for your listing)?[.!]?$/i,
    /^(?:airbnb:\s*)?new [1-5](?:\.\d)?[- ]star (?:review|rating)(?:\s+(?:from|by)\s+.+)?[.!]?$/i,
    /^your listing (?:received|got) (?:a )?new (?:guest )?(?:review|rating)[.!]?$/i,
    /\b(?:left|wrote|submitted|posted) you (?:a )?(?:review|rating)[.!]?$/i,
    /\b(?:left|gave) you (?:a )?[1-5](?:\.\d)?[- ]star (?:review|rating)[.!]?$/i,
    /\b(?:guest|travell?er)\b.{0,40}\b(?:left|wrote|posted|gave) (?:you )?(?:a )?(?:[1-5](?:\.\d)?[- ]star )?(?:review|rating)\b/i,
    /\b(?:guest|travell?er)\b.{0,40}\bsubmitted (?:a )?(?:review|rating|feedback)\b/i,
    /\b(?:guest|travell?er)\b.{0,40}\b(?:rated|gave) you [1-5](?:\.\d)?(?: out of 5)? stars?\b/i,
    /\b(?:gave|rated) (?:you|your stay|their stay|the stay|your listing) [1-5](?:\.\d)?(?: out of 5)? stars?[.!]?$/i,
    /^(?:airbnb:\s*)?read (?!airbnb['’]s|(?:our|the) team['’]s|support['’]s).{1,60}['’]s review[.!]?$/i,
    /^(?:you (?:received|got) (?:a )?)?[1-5](?:\.\d)?[- ]star (?:review|rating)[.!]?$/i,
    /\b(?:review|rating) from (?:your )?guest\b/i,
  ];
  return positivePatterns.some((pattern) => pattern.test(value));
};

const classifyRelevantAirbnbOtaEvent = ({
  inboundRecord = {},
  email = {},
  normalized = {},
  reconciliation = {},
} = {}) => {
  if (
    !isAirbnbOtaInbound({ inboundRecord, email, normalized, reconciliation })
  ) {
    return {
      eligible: false,
      kind: "",
      label: "",
      reason: "not_airbnb",
    };
  }

  const persisted = inboundRecord.normalizedReservation || {};
  const subject = notificationSubject({ inboundRecord, email, normalized });
  const communicationReasons = guestCommunicationReasons({
    inboundRecord,
    normalized,
    reconciliation,
  });
  const airbnbHotelRunnerRelay = isAirbnbHotelRunnerGuestMessageRelay({
    inboundRecord,
    email,
    normalized,
    reconciliation,
  });
  const airbnbProviderMessageSubject =
    /\b(?:new )?message from (?:the |your )?airbnb(?:['’]s)?\b/i.test(
      subject
    ) ||
    /\b(?:your )?airbnb(?:['’]s)?(?:\s+[a-z][a-z'-]*){0,6}\s+(?:sent|wrote) (?:you )?(?:a )?message\b/i.test(
      subject
    );
  if (
    (communicationReasons.includes("airbnb_guest_message") &&
      !airbnbProviderMessageSubject) ||
    airbnbHotelRunnerRelay
  ) {
    return {
      eligible: true,
      kind: "guest_message",
      label: "Guest message",
      reason: airbnbHotelRunnerRelay
        ? "airbnb_guest_message_via_hotelrunner"
        : "airbnb_guest_message",
    };
  }

  if (isAirbnbGuestReviewOrRatingSubject(subject)) {
    return {
      eligible: true,
      kind: "review_rating",
      label: "Guest review/rating",
      reason: "airbnb_guest_review_or_rating",
    };
  }

  const intent = firstMeaningfulText(
    normalized.intent,
    persisted.intent,
    inboundRecord.intent
  ).toLowerCase();
  const eventType = firstMeaningfulText(
    normalized.eventType,
    persisted.eventType,
    inboundRecord.eventType
  ).toLowerCase();
  const statusToApply = firstMeaningfulText(
    normalized.statusToApply,
    persisted.statusToApply
  )
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  const reconciliationStatus = firstMeaningfulText(
    reconciliation.status,
    inboundRecord.reconciliation?.status
  ).toLowerCase();
  const reservationIdentityCandidates = [
    normalized.confirmationNumber,
    normalized.reservationId,
    persisted.confirmationNumber,
    persisted.reservationId,
    inboundRecord.confirmationNumber,
    reconciliation.reservationId,
    inboundRecord.reservationMongoId,
  ];
  const hasReliableReservationIdentity = reservationIdentityCandidates.some(
    isReliableAirbnbReservationIdentity
  );

  if (
    ["cancelled", "status_updated"].includes(reconciliationStatus) ||
    (intent === "reservation_status" &&
      hasReliableReservationIdentity &&
      AIRBNB_STATUS_VALUES.has(statusToApply))
  ) {
    const noShow = statusToApply === "no_show" || eventType === "no_show";
    const cancelled =
      reconciliationStatus === "cancelled" ||
      ["cancelled", "canceled"].includes(statusToApply) ||
      ["cancelled", "canceled"].includes(eventType);
    return {
      eligible: true,
      kind: "reservation_update",
      label: noShow
        ? "Reservation no-show"
        : cancelled
        ? "Reservation cancelled"
        : "Reservation status update",
      reason: "airbnb_reservation_status",
    };
  }
  if (
    reconciliationStatus === "created" ||
    (intent === "new_reservation" && hasReliableReservationIdentity)
  ) {
    return {
      eligible: true,
      kind: "new_reservation",
      label: "New reservation",
      reason: "airbnb_new_reservation",
    };
  }
  if (
    reconciliationStatus === "updated" ||
    (intent === "reservation_update" && hasReliableReservationIdentity)
  ) {
    return {
      eligible: true,
      kind: "reservation_update",
      label: "Reservation update",
      reason: "airbnb_reservation_update",
    };
  }

  return {
    eligible: false,
    kind: "",
    label: "",
    reason: "unsupported_airbnb_event",
  };
};

const airbnbEventLabel = (context = {}) =>
  classifyRelevantAirbnbOtaEvent(context).label || "New OTA email";

const isRelevantAirbnbOtaEvent = (context = {}) =>
  classifyRelevantAirbnbOtaEvent(context).eligible;

const buildAirbnbOtaWhatsappSummary = ({
  inboundRecord = {},
  email = {},
  normalized = {},
  reconciliation = {},
} = {}) => {
  const label = airbnbEventLabel({
    inboundRecord,
    email,
    normalized,
    reconciliation,
  });
  const confirmation = firstText(
    normalized.confirmationNumber,
    inboundRecord.confirmationNumber
  ).toUpperCase();
  const hotel = firstText(
    normalized.hotelName,
    inboundRecord.hotelName,
    normalized.airbnbListingTitle
  );
  const checkin = normalizeText(normalized.checkinDate);
  const checkout = normalizeText(normalized.checkoutDate);
  const subject = notificationSubject({ inboundRecord, email, normalized });
  const status = normalizeText(
    reconciliation.status || inboundRecord.processingStatus
  ).toLowerCase();

  const parts = [label];
  if (confirmation) parts.push(`Ref ${redactedSummaryPart(confirmation, 32)}`);
  if (hotel) parts.push(redactedSummaryPart(hotel, 70));
  if (checkin || checkout) {
    parts.push(
      `Stay ${redactedSummaryPart(checkin || "?", 20)} to ${redactedSummaryPart(
        checkout || "?",
        20
      )}`
    );
  }
  if (["needs_review", "needs_mapping", "failed"].includes(status)) {
    parts.push(`Status ${status.replace(/_/g, " ")}`);
  }
  if (subject) parts.push(`Subject: ${redactedSummaryPart(subject, 100)}`);

  const summary = parts.join(" | ");
  return summary.length <= MAX_SUMMARY_LENGTH
    ? summary
    : `${summary.slice(0, MAX_SUMMARY_LENGTH - 3).trimEnd()}...`;
};

const defaultSendNotification = (payload) => {
  const {
    waSendAirbnbOtaNotificationToNumber,
  } = require("../controllers/whatsappsender");
  return waSendAirbnbOtaNotificationToNumber(payload);
};

const defaultPersistAudit = async ({ inboundEmailId, audit }) => {
  const InboundEmail = require("../models/inbound_email");
  return InboundEmail.findByIdAndUpdate(
    inboundEmailId,
    { $set: { airbnbWhatsappNotification: audit } },
    { new: true }
  )
    .lean()
    .exec();
};

const withTimeout = (promise, timeoutMs) => {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const timeoutError = new Error(
          `Twilio submission result was not known after ${timeoutMs}ms`
        );
        timeoutError.code = "AIRBNB_WHATSAPP_SUBMISSION_TIMEOUT";
        reject(timeoutError);
      }, timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
};

const deliveryFromSettledResult = (recipient, settled) => {
  if (settled.status === "rejected") {
    const timedOut =
      settled.reason?.code === "AIRBNB_WHATSAPP_SUBMISSION_TIMEOUT";
    const providerError = timedOut
      ? normalizeText(settled.reason?.message || settled.reason)
      : normalizeText(
          [
            settled.reason?.code ? `Twilio ${settled.reason.code}` : "",
            settled.reason?.status ? `HTTP ${settled.reason.status}` : "",
            settled.reason?.message || settled.reason,
          ]
            .filter(Boolean)
            .join(": ")
        );
    return {
      to: recipient,
      status: timedOut ? "unknown" : "failed",
      messageSid: "",
      providerStatus: "",
      error: providerError.slice(0, 240),
    };
  }

  const result = settled.value || {};
  const skipped = result.skipped === true || result.dryRun === true;
  const providerStatus = normalizeText(result.status).toLowerCase();
  const providerFailed = [
    "failed",
    "undelivered",
    "canceled",
    "cancelled",
  ].includes(providerStatus);
  const submitted =
    !skipped && !providerFailed && Boolean(result.sid || result.ok);
  const providerErrorCode = normalizeText(result.errorCode);
  const providerErrorMessage = firstText(
    result.error,
    result.errorMessage,
    result.reason
  );
  return {
    to: recipient,
    status: skipped ? "skipped" : submitted ? "submitted" : "failed",
    messageSid: normalizeText(result.sid),
    providerStatus,
    error: normalizeText(
      [
        providerErrorCode ? `Twilio ${providerErrorCode}` : "",
        providerErrorMessage,
      ]
        .filter(Boolean)
        .join(": ")
    ).slice(0, 240),
  };
};

const notifyAirbnbOtaInboundWhatsapp = async (
  { inboundRecord = {}, email = {}, normalized = {}, reconciliation = {} } = {},
  dependencies = {}
) => {
  if (
    !isAirbnbOtaInbound({ inboundRecord, email, normalized, reconciliation })
  ) {
    return {
      attempted: false,
      status: "not_required",
      reason: "not_airbnb",
      record: inboundRecord,
    };
  }
  if (isDuplicateInboundDelivery({ inboundRecord, reconciliation })) {
    return {
      attempted: false,
      status: "not_required",
      reason: "duplicate_email",
      record: inboundRecord,
    };
  }
  const eventDecision = classifyRelevantAirbnbOtaEvent({
    inboundRecord,
    email,
    normalized,
    reconciliation,
  });
  if (!eventDecision.eligible) {
    return {
      attempted: false,
      status: "not_required",
      reason: eventDecision.reason,
      record: inboundRecord,
    };
  }
  if (!inboundRecord?._id) {
    return {
      attempted: false,
      status: "not_required",
      reason: "inbound_email_not_saved",
      record: inboundRecord,
    };
  }

  const sendNotification =
    dependencies.sendNotification || defaultSendNotification;
  const persistAudit = dependencies.persistAudit || defaultPersistAudit;
  const now = dependencies.now || (() => new Date());
  const configuredTimeoutMs = Number(
    dependencies.sendTimeoutMs || DEFAULT_SEND_TIMEOUT_MS
  );
  const sendTimeoutMs = Number.isFinite(configuredTimeoutMs)
    ? Math.max(1000, configuredTimeoutMs)
    : DEFAULT_SEND_TIMEOUT_MS;
  const recipients = Array.isArray(dependencies.recipients)
    ? uniqueStrings(dependencies.recipients)
    : getAirbnbOtaWhatsappRecipients();
  const message = buildAirbnbOtaWhatsappSummary({
    inboundRecord,
    email,
    normalized,
    reconciliation,
  });
  const attemptedAt = now();
  const settled = await Promise.allSettled(
    recipients.map((toE164) =>
      withTimeout(
        Promise.resolve().then(() =>
          sendNotification({
            toE164,
            recipientName: "Jannat Admin",
            summary: message,
          })
        ),
        sendTimeoutMs
      )
    )
  );
  const deliveries = settled.map((result, index) =>
    deliveryFromSettledResult(recipients[index], result)
  );
  const submittedCount = deliveries.filter(
    (item) => item.status === "submitted"
  ).length;
  const failedCount = deliveries.filter(
    (item) => item.status === "failed"
  ).length;
  const unknownCount = deliveries.filter(
    (item) => item.status === "unknown"
  ).length;
  const skippedCount = deliveries.filter(
    (item) => item.status === "skipped"
  ).length;
  const status =
    submittedCount === recipients.length && recipients.length > 0
      ? "submitted"
      : submittedCount > 0
      ? "partial"
      : unknownCount > 0
      ? "unknown"
      : failedCount > 0
      ? "failed"
      : "skipped";
  const audit = {
    status,
    message,
    recipients,
    deliveries,
    attemptedAt,
    completedAt: now(),
  };

  let record = inboundRecord;
  let auditError = "";
  try {
    const persisted = await persistAudit({
      inboundEmailId: inboundRecord._id,
      audit,
    });
    if (persisted) record = persisted;
  } catch (error) {
    auditError = normalizeText(error?.message || error).slice(0, 240);
  }

  return {
    attempted: true,
    ...audit,
    submittedCount,
    failedCount,
    unknownCount,
    skippedCount,
    auditError,
    record,
  };
};

module.exports = {
  DEFAULT_AIRBNB_OTA_WHATSAPP_RECIPIENTS,
  DEFAULT_SEND_TIMEOUT_MS,
  MAX_SUMMARY_LENGTH,
  airbnbEventLabel,
  buildAirbnbOtaWhatsappSummary,
  classifyRelevantAirbnbOtaEvent,
  getAirbnbOtaWhatsappRecipients,
  isAirbnbOtaInbound,
  isDuplicateInboundDelivery,
  isRelevantAirbnbOtaEvent,
  notifyAirbnbOtaInboundWhatsapp,
};
