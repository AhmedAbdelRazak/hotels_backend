/** @format */

"use strict";

const fs = require("node:fs");
const bwipjs = require("bwip-js");

const embeddedArabicFontCss = [
  [400, "noto-sans-arabic-arabic-400-normal.woff2"],
  [800, "noto-sans-arabic-arabic-800-normal.woff2"],
]
  .map(([weight, filename]) => {
    const fontPath = require.resolve(
      `@fontsource/noto-sans-arabic/files/${filename}`
    );
    const encoded = fs.readFileSync(fontPath).toString("base64");
    return `@font-face{font-family:"Jannat Noto Arabic";font-style:normal;font-display:block;font-weight:${weight};src:url(data:font/woff2;base64,${encoded}) format("woff2")}`;
  })
  .join("");

const CARD_VERSION = 1;
const BARCODE_MAX_LENGTH = 80;
const PAYMENT_BREAKDOWN_FIELDS = [
  "paid_online_via_link",
  "paid_online_via_instapay",
  "paid_no_show",
  "paid_at_hotel_cash",
  "paid_at_hotel_card",
  "paid_to_hotel",
  "paid_to_zad",
  "paid_online_jannatbooking",
  "paid_online_other_platforms",
];

const ARABIC_MONTHS = [
  "يناير",
  "فبراير",
  "مارس",
  "أبريل",
  "مايو",
  "يونيو",
  "يوليو",
  "أغسطس",
  "سبتمبر",
  "أكتوبر",
  "نوفمبر",
  "ديسمبر",
];

const ENGLISH_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const cleanText = (value, maxLength = 180) =>
  String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);

const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const toFiniteNumber = (value, fallback = 0) => {
  const number = Number(
    String(value ?? "")
      .replace(/,/g, "")
      .trim()
  );
  return Number.isFinite(number) ? number : fallback;
};

const positiveInteger = (value, fallback = 0) => {
  const number = Math.floor(toFiniteNumber(value, fallback));
  return number > 0 ? number : fallback;
};

const toDateParts = (value) => {
  if (!value) return null;
  const raw = String(value).trim();
  const dateOnlyMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T)/);
  if (dateOnlyMatch) {
    const year = Number(dateOnlyMatch[1]);
    const month = Number(dateOnlyMatch[2]);
    const day = Number(dateOnlyMatch[3]);
    if (
      Number.isInteger(year) &&
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= 31
    ) {
      return { year, month, day };
    }
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  return {
    year: parsed.getUTCFullYear(),
    month: parsed.getUTCMonth() + 1,
    day: parsed.getUTCDate(),
  };
};

const formatDatePair = (value) => {
  const parts = toDateParts(value);
  if (!parts) return { english: "N/A", arabic: "غير متاح", iso: "" };
  const monthIndex = parts.month - 1;
  return {
    english: `${parts.day} ${ENGLISH_MONTHS[monthIndex]}, ${parts.year}`,
    arabic: `${parts.day} ${ARABIC_MONTHS[monthIndex]}، ${parts.year}`,
    iso: `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(
      parts.day
    ).padStart(2, "0")}`,
  };
};

const datePartsToUtc = (parts) =>
  parts ? Date.UTC(parts.year, parts.month - 1, parts.day) : Number.NaN;

const calculateNights = (checkin, checkout, storedNights) => {
  const start = datePartsToUtc(toDateParts(checkin));
  const end = datePartsToUtc(toDateParts(checkout));
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
    return Math.round((end - start) / 86_400_000);
  }
  return positiveInteger(storedNights, 0);
};

const titleCaseLatin = (value) => {
  const text = cleanText(value);
  if (!text || /[\u0600-\u06FF]/.test(text) || text !== text.toLowerCase()) {
    return text;
  }
  return text.replace(
    /(^|[\s-])([a-z])/g,
    (_match, prefix, letter) => `${prefix}${letter.toUpperCase()}`
  );
};

const normalizeRoomKey = (value) =>
  cleanText(value, 120)
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, "");

const buildRoomLabels = (reservation = {}, hotel = {}) => {
  const details = Array.isArray(hotel?.roomCountDetails)
    ? hotel.roomCountDetails
    : [];
  const detailByKey = new Map();
  details.forEach((room) => {
    [
      room?.roomType,
      room?.room_type,
      room?.displayName,
      room?.display_name,
    ].forEach((candidate) => {
      const key = normalizeRoomKey(candidate);
      if (key && !detailByKey.has(key)) detailByKey.set(key, room);
    });
  });

  const selections = Array.isArray(reservation?.pickedRoomsType)
    ? reservation.pickedRoomsType
    : [];
  const grouped = new Map();
  selections.forEach((room) => {
    const detail =
      detailByKey.get(normalizeRoomKey(room?.room_type || room?.roomType)) ||
      detailByKey.get(
        normalizeRoomKey(room?.displayName || room?.display_name)
      ) ||
      {};
    const english = titleCaseLatin(
      room?.displayName ||
        room?.display_name ||
        detail?.displayName ||
        detail?.display_name ||
        room?.room_type ||
        room?.roomType ||
        "Room"
    );
    const arabic = cleanText(
      room?.displayName_OtherLanguage ||
        detail?.displayName_OtherLanguage ||
        english
    );
    const count = positiveInteger(room?.count, 1);
    const key = `${english.toLowerCase()}__${arabic}`;
    const current = grouped.get(key) || { english, arabic, count: 0 };
    current.count += count;
    grouped.set(key, current);
  });

  if (!grouped.size) {
    return { english: "N/A", arabic: "غير متاح", rooms: [] };
  }
  const rooms = Array.from(grouped.values());
  const format = (room, language) => {
    const value = language === "ar" ? room.arabic : room.english;
    return room.count > 1 ? `${value} × ${room.count}` : value;
  };
  return {
    english: cleanText(
      rooms.map((room) => format(room, "en")).join(" • "),
      320
    ),
    arabic: cleanText(rooms.map((room) => format(room, "ar")).join(" • "), 320),
    rooms,
  };
};

const buildPaymentStatus = (reservation = {}) => {
  const total = Math.max(toFiniteNumber(reservation?.total_amount, 0), 0);
  const breakdown = reservation?.paid_amount_breakdown || {};
  const breakdownPaid = PAYMENT_BREAKDOWN_FIELDS.reduce(
    (sum, field) => sum + Math.max(toFiniteNumber(breakdown?.[field], 0), 0),
    0
  );
  const rawPaid = Math.max(toFiniteNumber(reservation?.paid_amount, 0), 0);
  const onsitePaid = Math.max(
    toFiniteNumber(reservation?.payment_details?.onsite_paid_amount, 0),
    0
  );
  const paymentMode = cleanText(
    reservation?.payment ||
      reservation?.payment_status ||
      reservation?.financeStatus ||
      ""
  ).toLowerCase();
  const financeStatus = cleanText(
    reservation?.financeStatus || ""
  ).toLowerCase();
  const paymentDetails = reservation?.payment_details || {};
  const paypalDetails = reservation?.paypal_details || {};
  const capturedTotalSar = Math.max(
    toFiniteNumber(paypalDetails?.captured_total_sar, 0),
    0
  );
  const gatewayCaptured =
    paymentDetails?.captured === true ||
    capturedTotalSar > 0 ||
    String(
      paypalDetails?.initial?.capture_status ||
        paypalDetails?.initial?.status ||
        ""
    ).toUpperCase() === "COMPLETED" ||
    (Array.isArray(paypalDetails?.captures) &&
      paypalDetails.captures.some(
        (item) =>
          String(item?.capture_status || item?.status || "").toUpperCase() ===
          "COMPLETED"
      ));
  const authorizationOnly =
    financeStatus === "authorized" ||
    /(credit\s*\/?\s*debit|not\s+captured|authori[sz]ed|deposit\s+paid)/i.test(
      paymentMode
    );
  const settlementDeclared =
    financeStatus === "paid" ||
    /(paid\s+online|fully\s+paid|captured)/i.test(paymentMode);
  const legacyPaid = authorizationOnly ? onsitePaid : rawPaid + onsitePaid;
  const paid = breakdownPaid > 0 ? breakdownPaid : legacyPaid;
  const evidencedPaid = Math.max(paid, capturedTotalSar);
  const fullyPaid = total > 0 && evidencedPaid >= total - 0.01;
  if (fullyPaid) {
    return { key: "paid", english: "Paid", arabic: "مدفوع", tone: "paid" };
  }
  if (evidencedPaid > 0) {
    return {
      key: "partial",
      english: "Partially Paid",
      arabic: "مدفوع جزئياً",
      tone: "partial",
    };
  }
  if (total === 0) {
    return {
      key: "no_due",
      english: "No Payment Due",
      arabic: "لا يوجد مبلغ مستحق",
      tone: "paid",
    };
  }
  if (gatewayCaptured || settlementDeclared) {
    return {
      key: "captured_pending",
      english: "Payment Review",
      arabic: "مراجعة الدفع",
      tone: "pending",
    };
  }
  if (authorizationOnly) {
    return {
      key: "authorized",
      english: "Payment Authorized",
      arabic: "تم تفويض الدفع",
      tone: "pending",
    };
  }
  if (/(pay\s*at\s*hotel|paid\s*offline|hotel|cash)/i.test(paymentMode)) {
    return {
      key: "hotel",
      english: "Pay at Hotel",
      arabic: "الدفع في الفندق",
      tone: "pending",
    };
  }
  return {
    key: "unpaid",
    english: "Not Paid",
    arabic: "غير مدفوع",
    tone: "unpaid",
  };
};

const barcodeSvgDataUri = (reference) => {
  const text = cleanText(reference, BARCODE_MAX_LENGTH);
  if (!text) return "";
  const svg = bwipjs.toSVG({
    bcid: "code128",
    text,
    scale: 2,
    height: 12,
    includetext: false,
    paddingwidth: 4,
    paddingheight: 2,
    backgroundcolor: "FFFFFF",
  });
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString(
    "base64"
  )}`;
};

const buildGuestCardData = (reservation = {}, populatedHotel = null) => {
  const hotel =
    populatedHotel ||
    (reservation?.hotelId && typeof reservation.hotelId === "object"
      ? reservation.hotelId
      : {});
  const confirmationNumber = cleanText(reservation?.confirmation_number, 80);
  if (!confirmationNumber) {
    const error = new Error(
      "The reservation does not have a confirmation number."
    );
    error.code = "GUEST_CARD_CONFIRMATION_REQUIRED";
    throw error;
  }
  const secondaryReference = [
    reservation?.pms_number,
    reservation?.customer_details?.confirmation_number2,
  ]
    .map((value) => cleanText(value, 80))
    .find(
      (value) =>
        value && value.toLowerCase() !== confirmationNumber.toLowerCase()
    );
  const roomType = buildRoomLabels(reservation, hotel);
  const checkin = formatDatePair(reservation?.checkin_date);
  const checkout = formatDatePair(reservation?.checkout_date);
  const bookingDate = formatDatePair(
    reservation?.booked_at || reservation?.createdAt
  );
  const fallbackGuests =
    positiveInteger(reservation?.adults, 0) +
    positiveInteger(reservation?.children, 0);
  const guests =
    positiveInteger(reservation?.total_guests, 0) || fallbackGuests || 1;
  const nights = calculateNights(
    reservation?.checkin_date,
    reservation?.checkout_date,
    reservation?.days_of_residence
  );
  const paymentStatus = buildPaymentStatus(reservation);

  return {
    version: CARD_VERSION,
    reservationId: cleanText(reservation?._id, 80),
    confirmationNumber,
    secondaryReference: secondaryReference || "",
    bookingReference: secondaryReference
      ? `${confirmationNumber} / ${secondaryReference}`
      : confirmationNumber,
    hotelConfirmationNumber: confirmationNumber,
    hotelConfirmationLabel: {
      english: "Hotel Confirmation No.",
      arabic: "رقم تأكيد الفندق",
    },
    barcodeDataUri: barcodeSvgDataUri(confirmationNumber),
    hotelNameEnglish:
      titleCaseLatin(hotel?.hotelName || reservation?.hotelName) ||
      "Jannat Booking",
    hotelNameArabic:
      cleanText(hotel?.hotelName_OtherLanguage) ||
      titleCaseLatin(hotel?.hotelName || reservation?.hotelName) ||
      "جنات للحجز الفندقي",
    guestName:
      cleanText(
        reservation?.customer_details?.fullName ||
          reservation?.customer_details?.name,
        140
      ) || "N/A",
    guestEmail: cleanText(reservation?.customer_details?.email, 254),
    roomTypeEnglish: roomType.english,
    roomTypeArabic: roomType.arabic,
    rooms: roomType.rooms,
    checkin,
    checkout,
    bookingDate,
    guests,
    nights,
    paymentStatus,
  };
};

const guestCardCss = `
${embeddedArabicFontCss}*{box-sizing:border-box}html,body{margin:0;background:#fff;color:#050505;font-family:Arial,"Jannat Noto Arabic",Tahoma,sans-serif}[lang="ar"]{font-family:"Jannat Noto Arabic",Tahoma,sans-serif}.guest-card-page{align-items:center;background:#fff;display:flex;height:820px;justify-content:center;width:1200px}.jannat-guest-card{background:#fff;border:4px solid #050505;display:grid;grid-template-rows:138px 22px 85px 70px 1fr 96px;height:800px;overflow:hidden;width:1170px}.jgc-header{align-items:center;background:#4e5654;display:flex;justify-content:space-between;padding:16px 62px 12px}.jgc-brand{color:#fff;display:grid;line-height:1}.jgc-brand-main{font-size:58px;font-weight:300;letter-spacing:5px}.jgc-brand-sub{color:#ff861c;font-size:19px;font-weight:800;justify-self:end;margin-right:5px}.jgc-title{color:#ff861c;font-size:52px;font-weight:800}.jgc-stripe{background:#ff861c}.jgc-hotel{align-content:center;background:#e4e5e8;display:grid;gap:2px;justify-items:center;padding:7px 20px;text-align:center}.jgc-hotel-en,.jgc-hotel-ar{font-size:28px;font-weight:800;line-height:1.15}.jgc-hotel-en.compact,.jgc-hotel-ar.compact{font-size:23px}.jgc-hotel-en.dense,.jgc-hotel-ar.dense{font-size:19px}.jgc-booking{align-content:center;background:#050505;color:#fff;display:grid;font-size:21px;gap:3px;justify-items:center;line-height:1.15;padding:7px}.jgc-body{display:grid;grid-template-rows:minmax(0,1fr) 116px;min-height:0}.jgc-main{display:grid;gap:32px;grid-template-columns:1.35fr 1fr;min-height:0;padding:8px 22px 8px}.jgc-section-title{font-size:27px;font-weight:900;line-height:1.05;margin:0 0 10px;text-align:center}.jgc-section-title .ar{display:block;font-size:24px;margin-top:2px}.jgc-detail-list{display:grid;gap:10px}.jgc-detail-row{border:3px solid #111;display:grid;grid-template-columns:220px 1fr;min-height:62px}.jgc-detail-label{align-content:center;border-right:3px solid #111;display:grid;font-size:20px;font-weight:800;line-height:1.1;padding:4px;text-align:center}.jgc-detail-value{align-content:center;display:grid;font-size:21px;font-weight:700;line-height:1.16;overflow-wrap:anywhere;padding:5px 12px;text-align:center}.jgc-detail-value.compact{font-size:17px}.jgc-detail-value.dense{font-size:13px;line-height:1.1}.jgc-confirm{align-content:start;display:grid;padding-top:6px}.jgc-confirm-heading{font-size:30px;font-weight:900;margin:0 0 11px;text-align:center}.jgc-confirm-box{background:linear-gradient(135deg,#f7f8f9,#e2e5e8);border:2px solid #333;display:grid;justify-items:center;margin:0 auto;max-width:420px;padding:8px 22px 6px;width:100%}.jgc-confirm-label{font-size:18px;font-weight:800;text-align:center}.jgc-confirm-number{color:#167234;font-size:40px;font-weight:900;line-height:1.05;margin:3px 0;overflow-wrap:anywhere;text-align:center}.jgc-confirm-number.compact{font-size:31px}.jgc-confirm-number.dense{font-size:23px}.jgc-barcode{display:block;height:52px;max-width:320px;object-fit:contain;width:100%}.jgc-stay{display:grid;grid-template-columns:2fr repeat(3,1fr);min-height:0;padding:0 18px 6px}.jgc-dates,.jgc-metric{border:3px solid #111;min-height:0;min-width:0}.jgc-dates{display:grid;grid-template-rows:1fr 1fr}.jgc-date-row{display:grid;grid-template-columns:190px 1fr;min-height:0}.jgc-date-row:first-child{border-bottom:3px solid #111}.jgc-date-label{align-content:center;border-right:3px solid #111;display:grid;font-size:16px;font-weight:900;line-height:1.1;padding:2px;text-align:center}.jgc-date-value{align-content:center;display:grid;font-size:16px;line-height:1.14;padding:2px 7px;text-align:center}.jgc-metric{border-left:0;display:grid;grid-template-rows:1fr 1fr;text-align:center}.jgc-metric-label{align-content:center;border-bottom:3px solid #111;display:grid;font-size:17px;font-weight:900;line-height:1.08;padding:2px}.jgc-metric-value{align-content:center;display:grid;font-size:20px;line-height:1.08;padding:2px}.jgc-payment.paid{background:#c6f1cf;color:#078320;font-weight:900}.jgc-payment.partial{background:#fff0bd;color:#8b5a00;font-weight:900}.jgc-payment.pending{background:#fff5d7;color:#7a4b00;font-weight:900}.jgc-payment.unpaid{background:#fee2e2;color:#a31313;font-weight:900}.jgc-footer{border-top:3px solid #111;display:grid;font-size:14px;line-height:1.18;padding:6px 34px}.jgc-footer strong{font-size:16px}.jgc-footer-en{direction:ltr;text-align:left}.jgc-footer-ar{direction:rtl;text-align:right}.jgc-ltr{direction:ltr;unicode-bidi:isolate}@page{size:1200px 820px;margin:0}@media print{html,body{height:820px;width:1200px}}
`;

const renderGuestCardMarkup = (card = {}) => {
  const value = (field, fallback = "N/A") =>
    escapeHtml(cleanText(field, 400) || fallback);
  const density = (field, compactAt = 70, denseAt = 145) => {
    const length = String(field || "").length;
    if (length > denseAt) return " dense";
    if (length > compactAt) return " compact";
    return "";
  };
  const barcode = card?.barcodeDataUri
    ? `<img class="jgc-barcode" alt="Barcode for confirmation ${value(
        card.confirmationNumber
      )}" src="${escapeHtml(card.barcodeDataUri)}">`
    : "";
  return `<article class="jannat-guest-card" aria-label="Jannat guest card">
	<header class="jgc-header"><div class="jgc-brand"><span class="jgc-brand-main">JANNAT</span><span class="jgc-brand-sub">Booking.com</span></div><div class="jgc-title">Guest Card</div></header>
	<div class="jgc-stripe"></div>
	<section class="jgc-hotel"><div class="jgc-hotel-en${density(
    card.hotelNameEnglish,
    45,
    85
  )}" lang="en">${value(
    card.hotelNameEnglish
  )}</div><div class="jgc-hotel-ar${density(
    card.hotelNameArabic,
    45,
    85
  )}" lang="ar" dir="rtl">${value(
    card.hotelNameArabic,
    "غير متاح"
  )}</div></section>
	<section class="jgc-booking"><div>Booking No: <bdi class="jgc-ltr">${value(
    card.bookingReference
  )}</bdi></div><div>Booking Date: <bdi class="jgc-ltr">${value(
    card?.bookingDate?.english
  )}</bdi></div></section>
	<div class="jgc-body"><div class="jgc-main"><section><h2 class="jgc-section-title">Reservation Details<span class="ar" lang="ar" dir="rtl">تفاصيل الحجز</span></h2><div class="jgc-detail-list"><div class="jgc-detail-row"><div class="jgc-detail-label">Guest Name<span lang="ar" dir="rtl">اسم الضيف</span></div><div class="jgc-detail-value${density(
    card.guestName,
    55,
    100
  )}">${value(
    card.guestName
  )}</div></div><div class="jgc-detail-row"><div class="jgc-detail-label">Room Type<span lang="ar" dir="rtl">نوع الغرفة</span></div><div class="jgc-detail-value${density(
    `${card.roomTypeEnglish || ""}${card.roomTypeArabic || ""}`,
    90,
    180
  )}"><span lang="en">${value(
    card.roomTypeEnglish
  )}</span><span lang="ar" dir="rtl">${value(
    card.roomTypeArabic,
    "غير متاح"
  )}</span></div></div></div></section><section class="jgc-confirm"><h2 class="jgc-confirm-heading" lang="ar" dir="rtl">رقم حجز الفندق</h2><div class="jgc-confirm-box"><div class="jgc-confirm-label">${value(
    card?.hotelConfirmationLabel?.english,
    "Confirmation Number"
  )}</div><bdi class="jgc-confirm-number jgc-ltr${density(
    card.hotelConfirmationNumber,
    18,
    32
  )}">${value(
    card.hotelConfirmationNumber
  )}</bdi>${barcode}</div></section></div>
	<div class="jgc-stay"><div class="jgc-dates"><div class="jgc-date-row"><div class="jgc-date-label">Check-in Date<span lang="ar" dir="rtl">تاريخ الوصول</span></div><div class="jgc-date-value"><span>${value(
    card?.checkin?.english
  )}</span><span lang="ar" dir="rtl">${value(
    card?.checkin?.arabic,
    "غير متاح"
  )}</span></div></div><div class="jgc-date-row"><div class="jgc-date-label">Checkout Date<span lang="ar" dir="rtl">تاريخ المغادرة</span></div><div class="jgc-date-value"><span>${value(
    card?.checkout?.english
  )}</span><span lang="ar" dir="rtl">${value(
    card?.checkout?.arabic,
    "غير متاح"
  )}</span></div></div></div><div class="jgc-metric"><div class="jgc-metric-label">Guests<span lang="ar" dir="rtl">عدد الضيوف</span></div><div class="jgc-metric-value">${value(
    card.guests
  )}</div></div><div class="jgc-metric"><div class="jgc-metric-label">Nights<span lang="ar" dir="rtl">الليالي</span></div><div class="jgc-metric-value">${value(
    card.nights
  )}</div></div><div class="jgc-metric"><div class="jgc-metric-label">Payment Status<span lang="ar" dir="rtl">حالة الدفع</span></div><div class="jgc-metric-value jgc-payment ${value(
    card?.paymentStatus?.tone,
    "unpaid"
  )}"><span>${value(
    card?.paymentStatus?.english,
    "Not Paid"
  )}</span><span lang="ar" dir="rtl">${value(
    card?.paymentStatus?.arabic,
    "غير مدفوع"
  )}</span></div></div></div></div>
	<footer class="jgc-footer"><div class="jgc-footer-en"><strong>Our Dear Guest,</strong><br>We are waiting for your arrival. Kindly present this card to the receptionist. Thank you for booking with our hotel.</div><div class="jgc-footer-ar" lang="ar" dir="rtl"><strong>ضيفنا العزيز،</strong><br>يرجى تقديم هذه البطاقة إلى موظف الاستقبال. نحن في انتظار وصولكم، ونشكركم على حجزكم في فندقنا.</div></footer>
	</article>`;
};

const renderGuestCardDocument = (card) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=1200,initial-scale=1"><title>Guest Card ${escapeHtml(
    card?.confirmationNumber || ""
  )}</title><style>${guestCardCss}</style></head><body><main class="guest-card-page">${renderGuestCardMarkup(
    card
  )}</main></body></html>`;

const renderGuestCardEmail = (card) => {
  const hotel = escapeHtml(card?.hotelNameEnglish || "Jannat Booking");
  const guest = escapeHtml(card?.guestName || "Valued Guest");
  const reference = escapeHtml(card?.confirmationNumber || "");
  return `<!doctype html><html><body style="margin:0;background:#f4f6f8;font-family:Arial,Tahoma,sans-serif;color:#17202a"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f6f8;padding:24px 12px"><tr><td align="center"><table role="presentation" width="640" cellspacing="0" cellpadding="0" style="max-width:640px;background:#fff;border:1px solid #d8dee4;border-radius:10px;overflow:hidden"><tr><td style="background:#4e5654;color:#fff;padding:24px 30px"><strong style="font-size:28px;letter-spacing:2px">JANNAT</strong><span style="float:right;color:#ff861c;font-size:24px;font-weight:bold">Guest Card</span></td></tr><tr><td style="height:8px;background:#ff861c"></td></tr><tr><td style="padding:28px 30px"><p style="margin:0 0 12px;font-size:18px">Dear ${guest},</p><p style="margin:0 0 18px;line-height:1.6">Your guest card for <strong>${hotel}</strong> is attached as a PDF. Please keep it available and present it to reception when you arrive.</p><table role="presentation" width="100%" cellspacing="0" cellpadding="8" style="background:#f7f8fa;border:1px solid #e1e5e9"><tr><td><strong>Booking reference</strong></td><td dir="ltr" align="right">${reference}</td></tr><tr><td><strong>Check-in</strong></td><td align="right">${escapeHtml(
    card?.checkin?.english || "N/A"
  )}</td></tr><tr><td><strong>Checkout</strong></td><td align="right">${escapeHtml(
    card?.checkout?.english || "N/A"
  )}</td></tr></table><div dir="rtl" lang="ar" style="margin-top:24px;padding-top:20px;border-top:1px solid #e1e5e9;line-height:1.8;text-align:right"><strong>ضيفنا العزيز،</strong><br>بطاقة الضيف الخاصة بحجزكم مرفقة بصيغة PDF. يرجى الاحتفاظ بها وتقديمها لموظف الاستقبال عند الوصول.</div><p style="margin:24px 0 0;color:#667085;font-size:13px">This message was sent by an authorized Jannat Booking employee.</p></td></tr></table></td></tr></table></body></html>`;
};

const safeAttachmentName = (confirmationNumber) => {
  const safe =
    cleanText(confirmationNumber, 70)
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "reservation";
  return `Jannat_Guest_Card_${safe}.pdf`;
};

module.exports = {
  BARCODE_MAX_LENGTH,
  CARD_VERSION,
  buildGuestCardData,
  buildPaymentStatus,
  calculateNights,
  cleanText,
  escapeHtml,
  formatDatePair,
  guestCardCss,
  renderGuestCardDocument,
  renderGuestCardEmail,
  renderGuestCardMarkup,
  safeAttachmentName,
};
