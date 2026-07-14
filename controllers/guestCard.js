/** @format */

"use strict";

const mongoose = require("mongoose");
const { MailService } = require("@sendgrid/mail");
const Reservations = require("../models/reservations");
const {
  canManageOtaReservations,
  isConfiguredSuperAdmin,
  isOtaPlatformReviewPending,
} = require("../services/otaReservationVisibility");
const {
  buildGuestCardData,
  renderGuestCardDocument,
  renderGuestCardEmail,
  safeAttachmentName,
} = require("../services/guestCard");
const {
  GuestCardPdfBusyError,
  generateGuestCardPdf,
} = require("../services/guestCardPdf");

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SEND_COOLDOWN_MS = 10_000;
const SEND_RATE_WINDOW_MS = 60_000;
const SEND_RATE_MAX_ATTEMPTS = 5;
const SENDGRID_REQUEST_TIMEOUT_MS = 45_000;
const sendInProgress = new Set();
const recentSuccessfulSends = new Map();
const recentSendAttempts = new Map();
const guestCardMail = new MailService();

if (process.env.SENDGRID_API_KEY) {
  guestCardMail.setApiKey(process.env.SENDGRID_API_KEY);
}
guestCardMail.setTimeout(SENDGRID_REQUEST_TIMEOUT_MS);

const normalizeId = (value) =>
  String(value?._id || value?.id || value || "").trim();
const assignedHotelIds = (actor = {}) =>
  [
    actor.hotelIdWork,
    ...(Array.isArray(actor.hotelIdsWork) ? actor.hotelIdsWork : []),
    ...(Array.isArray(actor.hotelsToSupport) ? actor.hotelsToSupport : []),
    ...(Array.isArray(actor.hotelIdsOwner) ? actor.hotelIdsOwner : []),
  ]
    .map(normalizeId)
    .filter((id, index, values) => id && values.indexOf(id) === index);

const reservationFilterForActor = (reservationId, actor = {}) => {
  const filter = { _id: reservationId };
  const roleNumbers = [
    Number(actor?.role),
    ...(Array.isArray(actor?.roles)
      ? actor.roles.map((role) => Number(role))
      : []),
  ].filter(Number.isFinite);
  if (isConfiguredSuperAdmin(actor) || !roleNumbers.includes(1000))
    return filter;
  const hotelIds = assignedHotelIds(actor).filter((id) =>
    mongoose.Types.ObjectId.isValid(id)
  );
  return {
    ...filter,
    hotelId: { $in: hotelIds.map((id) => new mongoose.Types.ObjectId(id)) },
  };
};

const RESERVATION_GUEST_CARD_SELECT = [
  "_id",
  "confirmation_number",
  "pms_number",
  "customer_details.name",
  "customer_details.fullName",
  "customer_details.email",
  "customer_details.confirmation_number2",
  "checkin_date",
  "checkout_date",
  "days_of_residence",
  "booked_at",
  "createdAt",
  "total_guests",
  "adults",
  "children",
  "pickedRoomsType.room_type",
  "pickedRoomsType.roomType",
  "pickedRoomsType.displayName",
  "pickedRoomsType.display_name",
  "pickedRoomsType.displayName_OtherLanguage",
  "pickedRoomsType.count",
  "total_amount",
  "paid_amount",
  "paid_amount_breakdown",
  "payment",
  "payment_status",
  "financeStatus",
  "payment_details.captured",
  "payment_details.onsite_paid_amount",
  "paypal_details.captured_total_sar",
  "paypal_details.initial.capture_status",
  "paypal_details.initial.status",
  "paypal_details.captures.capture_status",
  "paypal_details.captures.status",
  "otaPlatformReview.status",
  "hotelId",
].join(" ");

const loadGuestCard = async (req) => {
  const reservationId = normalizeId(req.params?.reservationId);
  if (!mongoose.Types.ObjectId.isValid(reservationId)) {
    const error = new Error("A valid reservation id is required.");
    error.statusCode = 400;
    throw error;
  }
  const reservation = await Reservations.findOne(
    reservationFilterForActor(reservationId, req.profile)
  )
    .select(RESERVATION_GUEST_CARD_SELECT)
    .populate({
      path: "hotelId",
      select:
        "_id hotelName hotelName_OtherLanguage roomCountDetails.roomType roomCountDetails.displayName roomCountDetails.displayName_OtherLanguage",
    })
    .lean()
    .exec();
  if (!reservation) {
    const error = new Error("Reservation not found.");
    error.statusCode = 404;
    throw error;
  }
  if (
    isOtaPlatformReviewPending(reservation) &&
    !canManageOtaReservations(req.profile)
  ) {
    const error = new Error("Reservation not found.");
    error.statusCode = 404;
    throw error;
  }
  return buildGuestCardData(reservation, reservation.hotelId);
};

const setPrivateResponseHeaders = (res) => {
  res.set("Cache-Control", "private, no-store, max-age=0");
  res.set("Pragma", "no-cache");
  res.set("X-Content-Type-Options", "nosniff");
};

const normalizeRecipientEmail = (value) => {
  if (typeof value !== "string") return "";
  const email = value.trim().toLowerCase();
  if (
    !email ||
    email.length > 254 ||
    /[\r\n,;]/.test(email) ||
    !EMAIL_PATTERN.test(email)
  ) {
    return "";
  }
  return email;
};

const maskEmail = (email) => {
  const [local = "", domain = ""] = String(email || "").split("@");
  if (!domain) return "invalid";
  return `${local.slice(0, 2)}***@${domain}`;
};

const requestWasCancelled = (req = {}, res = {}) =>
  Boolean(req.aborted || res.destroyed || req.socket?.destroyed);

const pruneRecentSends = (now = Date.now()) => {
  for (const [key, sentAt] of recentSuccessfulSends.entries()) {
    if (now - sentAt > SEND_COOLDOWN_MS) recentSuccessfulSends.delete(key);
  }
  if (recentSuccessfulSends.size > 2_000) recentSuccessfulSends.clear();
};

const consumeSendAttempt = (actorId, now = Date.now()) => {
  const key = normalizeId(actorId) || "unknown";
  const cutoff = now - SEND_RATE_WINDOW_MS;
  const attempts = (recentSendAttempts.get(key) || []).filter(
    (attemptedAt) => attemptedAt > cutoff
  );
  if (attempts.length >= SEND_RATE_MAX_ATTEMPTS) {
    recentSendAttempts.set(key, attempts);
    return {
      allowed: false,
      retryAfter: Math.max(
        1,
        Math.ceil((attempts[0] + SEND_RATE_WINDOW_MS - now) / 1_000)
      ),
    };
  }
  attempts.push(now);
  recentSendAttempts.set(key, attempts);
  if (recentSendAttempts.size > 2_000) recentSendAttempts.clear();
  return { allowed: true, retryAfter: 0 };
};

const buildGuestCardEmailMessage = ({ recipientEmail, card, pdf }) => ({
  to: recipientEmail,
  from: {
    email: process.env.SENDGRID_FROM_EMAIL || "noreply@jannatbooking.com",
    name: "Jannat Booking",
  },
  replyTo: process.env.SENDGRID_REPLY_TO || "support@jannatbooking.com",
  subject: `Jannat Guest Card - ${card.confirmationNumber}`,
  html: renderGuestCardEmail(card),
  attachments: [
    {
      content: pdf.toString("base64"),
      filename: safeAttachmentName(card.confirmationNumber),
      type: "application/pdf",
      disposition: "attachment",
    },
  ],
});

exports.getAdminGuestCard = async (req, res) => {
  setPrivateResponseHeaders(res);
  try {
    const card = await loadGuestCard(req);
    return res.status(200).json({ success: true, card });
  } catch (error) {
    const status =
      error?.statusCode ||
      (error?.code === "GUEST_CARD_CONFIRMATION_REQUIRED" ? 422 : 500);
    if (status >= 500) {
      console.error("[GuestCard] Could not build card", {
        reservationId: normalizeId(req.params?.reservationId),
        error: error?.message || error,
      });
    }
    return res.status(status).json({
      success: false,
      error:
        status === 500 ? "Could not prepare the Guest Card." : error.message,
    });
  }
};

exports.emailAdminGuestCard = async (req, res) => {
  setPrivateResponseHeaders(res);
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const bodyKeys = Object.keys(body);
  if (bodyKeys.length !== 1 || bodyKeys[0] !== "recipientEmail") {
    return res.status(400).json({
      success: false,
      error: "Only one recipientEmail is allowed.",
    });
  }
  const recipientEmail = normalizeRecipientEmail(body.recipientEmail);
  if (!recipientEmail) {
    return res.status(400).json({
      success: false,
      error: "Enter one valid recipient email address.",
    });
  }
  if (!process.env.SENDGRID_API_KEY) {
    return res.status(503).json({
      success: false,
      error: "Guest Card email is temporarily unavailable.",
    });
  }

  const actorId = normalizeId(req.auth?._id || req.auth?.id);
  const reservationId = normalizeId(req.params?.reservationId);
  const sendKey = `${actorId}:${reservationId}`;
  const now = Date.now();
  pruneRecentSends(now);
  if (sendInProgress.has(sendKey)) {
    res.set("Retry-After", "5");
    return res.status(409).json({
      success: false,
      error: "This Guest Card email is already being sent.",
    });
  }
  const previousSendAt = recentSuccessfulSends.get(sendKey) || 0;
  if (now - previousSendAt < SEND_COOLDOWN_MS) {
    const retryAfter = Math.max(
      1,
      Math.ceil((SEND_COOLDOWN_MS - (now - previousSendAt)) / 1000)
    );
    res.set("Retry-After", String(retryAfter));
    return res.status(429).json({
      success: false,
      error:
        "The Guest Card was just sent. Please wait before sending it again.",
    });
  }
  const rateLimit = consumeSendAttempt(actorId, now);
  if (!rateLimit.allowed) {
    res.set("Retry-After", String(rateLimit.retryAfter));
    return res.status(429).json({
      success: false,
      error: "Too many Guest Card email attempts. Please try again shortly.",
    });
  }

  sendInProgress.add(sendKey);
  try {
    const card = await loadGuestCard(req);
    const pdf = await generateGuestCardPdf(renderGuestCardDocument(card));
    if (requestWasCancelled(req, res)) {
      const error = new Error("Guest Card email request was cancelled.");
      error.code = "GUEST_CARD_REQUEST_ABORTED";
      throw error;
    }
    const result = await guestCardMail.send(
      buildGuestCardEmailMessage({ recipientEmail, card, pdf })
    );
    recentSuccessfulSends.set(sendKey, Date.now());
    const response = Array.isArray(result) ? result[0] : result;
    console.info("[GuestCard] Email sent", {
      actorId,
      reservationId,
      recipient: maskEmail(recipientEmail),
      status: response?.statusCode || null,
      messageId:
        response?.headers?.["x-message-id"] ||
        response?.headers?.["x-request-id"] ||
        null,
    });
    return res.status(200).json({
      success: true,
      message: "Guest Card email sent successfully.",
    });
  } catch (error) {
    if (
      error?.code === "GUEST_CARD_REQUEST_ABORTED" ||
      requestWasCancelled(req, res)
    ) {
      console.info("[GuestCard] Email cancelled before send", {
        actorId,
        reservationId,
      });
      return undefined;
    }
    const isBusy = error instanceof GuestCardPdfBusyError;
    const isNotFound = error?.statusCode === 404;
    const isInvalidId = error?.statusCode === 400;
    const isInvalidCard = error?.code === "GUEST_CARD_CONFIRMATION_REQUIRED";
    const status = isBusy
      ? 429
      : isNotFound
      ? 404
      : isInvalidId
      ? 400
      : isInvalidCard
      ? 422
      : 502;
    if (isBusy) res.set("Retry-After", "15");
    console.error("[GuestCard] Email failed", {
      actorId,
      reservationId,
      recipient: maskEmail(recipientEmail),
      code: error?.code || null,
      error: error?.response?.body || error?.message || error,
    });
    return res.status(status).json({
      success: false,
      error: isBusy
        ? "Guest Card generation is busy. Please try again shortly."
        : isNotFound || isInvalidId || isInvalidCard
        ? error.message
        : "Could not send the Guest Card email.",
    });
  } finally {
    sendInProgress.delete(sendKey);
  }
};

exports._guestCardControllerTestables = {
  buildGuestCardEmailMessage,
  consumeSendAttempt,
  guestCardMail,
  loadGuestCard,
  maskEmail,
  normalizeRecipientEmail,
  requestWasCancelled,
  reservationFilterForActor,
};
