const fs = require("fs");
const path = require("path");
const flagCountries = require("flag-icons/country.json");

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

const safeNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const titleCase = (value) =>
  String(value || "")
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase());

const formatDate = (value, locale = "en-US") => {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return "N/A";
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
};

const calculateNights = (checkin, checkout) => {
  const start = new Date(checkin);
  const end = new Date(checkout);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 1;
  const startDay = Date.UTC(
    start.getUTCFullYear(),
    start.getUTCMonth(),
    start.getUTCDate()
  );
  const endDay = Date.UTC(
    end.getUTCFullYear(),
    end.getUTCMonth(),
    end.getUTCDate()
  );
  return Math.max(1, Math.round((endDay - startDay) / 86400000));
};

const normalizeCountryText = (value) =>
  String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[_.,()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const NATIONALITY_ALIASES = Object.freeze({
  afgan: "af",
  afghan: "af",
  algerian: "dz",
  american: "us",
  australian: "au",
  bahraini: "bh",
  bangladeshi: "bd",
  british: "gb",
  canadian: "ca",
  chinese: "cn",
  egyptian: "eg",
  emirati: "ae",
  ethiopian: "et",
  filipino: "ph",
  indian: "in",
  indonesian: "id",
  iraqi: "iq",
  jordanian: "jo",
  kuwaiti: "kw",
  lebanese: "lb",
  libyan: "ly",
  malaysian: "my",
  moroccan: "ma",
  nepali: "np",
  nigerian: "ng",
  omani: "om",
  pakistani: "pk",
  palestinian: "ps",
  qatari: "qa",
  saudi: "sa",
  "saudi arabian": "sa",
  somali: "so",
  sudanese: "sd",
  syrian: "sy",
  tunisian: "tn",
  turkish: "tr",
  yemeni: "ye",
  أردني: "jo",
  أردنية: "jo",
  إماراتي: "ae",
  إماراتية: "ae",
  باكستاني: "pk",
  باكستانية: "pk",
  سعودي: "sa",
  سعودية: "sa",
  سوداني: "sd",
  سودانية: "sd",
  سوري: "sy",
  سورية: "sy",
  عراقي: "iq",
  عراقية: "iq",
  فلسطيني: "ps",
  فلسطينية: "ps",
  مصري: "eg",
  مصرية: "eg",
  يمني: "ye",
  يمنية: "ye",
});

const countryCodes = new Set(
  flagCountries.filter((country) => country.iso).map((country) => country.code)
);
const countryNameIndex = new Map();
flagCountries.forEach((country) => {
  if (!country.iso) return;
  countryNameIndex.set(normalizeCountryText(country.name), country.code);
});
if (typeof Intl !== "undefined" && Intl.DisplayNames) {
  ["en", "ar"].forEach((locale) => {
    const names = new Intl.DisplayNames([locale], { type: "region" });
    countryCodes.forEach((code) => {
      countryNameIndex.set(
        normalizeCountryText(names.of(code.toUpperCase())),
        code
      );
    });
  });
}
countryNameIndex.set("united states of america", "us");
countryNameIndex.set(
  "united kingdom of great britain and northern ireland",
  "gb"
);
countryNameIndex.set("uae", "ae");
countryNameIndex.set("ksa", "sa");

const countryCodeFromNationality = (value) => {
  const normalized = normalizeCountryText(value);
  if (!normalized) return "";
  if (/^[a-z]{2}$/.test(normalized) && countryCodes.has(normalized)) {
    return normalized;
  }
  return (
    NATIONALITY_ALIASES[normalized] || countryNameIndex.get(normalized) || ""
  );
};

const displayNationality = (
  value,
  code = countryCodeFromNationality(value)
) => {
  const raw = String(value || "").trim();
  if (raw && !/^[A-Za-z]{2}$/.test(raw)) return raw;
  if (!code) return raw || "N/A";
  const preferred = {
    eg: "Egyptian",
    sa: "Saudi Arabian",
    ae: "Emirati",
    us: "American",
    gb: "British",
  };
  return (
    preferred[code] ||
    flagCountries.find((country) => country.code === code)?.name ||
    raw ||
    code.toUpperCase()
  );
};

const flagRoot = path.resolve(
  path.dirname(require.resolve("flag-icons")),
  ".."
);
const flagDataCache = new Map();

const flagDataUri = (countryCode) => {
  const code = String(countryCode || "").toLowerCase();
  if (!countryCodes.has(code)) return "";
  if (flagDataCache.has(code)) return flagDataCache.get(code);
  try {
    const svg = fs.readFileSync(
      path.join(flagRoot, "flags", "4x3", `${code}.svg`),
      "utf8"
    );
    const uri = `data:image/svg+xml;base64,${Buffer.from(svg).toString(
      "base64"
    )}`;
    flagDataCache.set(code, uri);
    return uri;
  } catch (error) {
    return "";
  }
};

const normalizeRoomKey = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");

const resolveRoomDefinition = (room, hotelInfo) => {
  const definitions = Array.isArray(hotelInfo?.roomCountDetails)
    ? hotelInfo.roomCountDetails
    : [];
  const typeKey = normalizeRoomKey(room?.room_type || room?.roomType);
  const nameKey = normalizeRoomKey(
    room?.displayName || room?.display_name || room?.room_display_name
  );
  return definitions.find((definition) => {
    const definitionType = normalizeRoomKey(
      definition?.roomType || definition?.room_type
    );
    const definitionName = normalizeRoomKey(
      definition?.displayName || definition?.display_name
    );
    return (
      (typeKey && definitionType === typeKey) ||
      (nameKey && definitionName === nameKey)
    );
  });
};

const publicDayPrice = (day) => {
  const candidates = [
    day?.totalPriceWithCommission,
    day?.price,
    day?.clientPrice,
    day?.sellingPrice,
  ];
  const resolved = candidates.find(
    (value) =>
      value !== null && value !== undefined && Number.isFinite(Number(value))
  );
  return resolved === undefined ? null : safeNumber(resolved);
};

const buildRoomRows = (reservationData, hotelInfo, nights) => {
  const rooms = Array.isArray(reservationData?.pickedRoomsType)
    ? reservationData.pickedRoomsType
    : [];
  const grouped = new Map();

  rooms.forEach((room) => {
    const definition = resolveRoomDefinition(room, hotelInfo);
    const englishName =
      room?.displayName ||
      room?.display_name ||
      room?.room_display_name ||
      definition?.displayName ||
      room?.room_type ||
      room?.roomType ||
      "Room";
    const arabicName =
      room?.displayName_OtherLanguage ||
      room?.displayNameArabic ||
      definition?.displayName_OtherLanguage ||
      "";
    const pricingByDay = Array.isArray(room?.pricingByDay)
      ? room.pricingByDay
      : [];
    const dailyPrices = pricingByDay
      .map(publicDayPrice)
      .filter((price) => price !== null);
    const chosenPrice = safeNumber(room?.chosenPrice);
    const rate =
      dailyPrices.length > 0
        ? dailyPrices.reduce((sum, price) => sum + price, 0) /
          dailyPrices.length
        : chosenPrice;
    const unitTotal =
      dailyPrices.length > 0
        ? dailyPrices.reduce((sum, price) => sum + price, 0)
        : rate * nights;
    const count = Math.max(1, Math.round(safeNumber(room?.count) || 1));
    const key = [
      normalizeRoomKey(room?.room_type || room?.roomType || englishName),
      normalizeRoomKey(englishName),
      rate.toFixed(2),
      unitTotal.toFixed(2),
    ].join("|");
    const existing = grouped.get(key);
    if (existing) {
      existing.count += count;
      existing.total += unitTotal * count;
    } else {
      grouped.set(key, {
        englishName,
        arabicName,
        count,
        rate,
        total: unitTotal * count,
      });
    }
  });

  return Array.from(grouped.values());
};

const derivePayment = (reservationData) => {
  const total = safeNumber(reservationData?.total_amount);
  const normalizedStatus = String(reservationData?.payment || "")
    .trim()
    .toLowerCase();
  const isNotCaptured = [
    "credit/ debit",
    "credit/debit",
    "credit / debit",
    "not captured",
  ].includes(normalizedStatus);
  const onlinePaid = isNotCaptured
    ? 0
    : safeNumber(reservationData?.paid_amount);
  const offlinePaid = safeNumber(
    reservationData?.payment_details?.onsite_paid_amount
  );
  const paid = Math.max(0, onlinePaid + offlinePaid);
  const remaining = Math.max(0, total - paid);
  const toCents = (value) => Math.round(safeNumber(value) * 100);
  const fullyPaid = paid > 0 && toCents(paid) >= toCents(total);
  const partiallyPaid = paid > 0 && !fullyPaid;
  let method = { en: "Not paid", ar: "غير مدفوع", tone: "unpaid" };
  if (isNotCaptured) {
    method = { en: "Not captured", ar: "غير محصل", tone: "pending" };
  } else if (fullyPaid) {
    method = { en: "Paid", ar: "مدفوع", tone: "paid" };
  } else if (partiallyPaid) {
    method =
      offlinePaid > 0
        ? { en: "Paid at property", ar: "مدفوع في الفندق", tone: "partial" }
        : { en: "Deposit", ar: "عربون", tone: "partial" };
  }
  return { total, paid, remaining, method };
};

const STATUS_TRANSLATIONS = Object.freeze({
  confirmed: "مؤكد",
  inhouse: "مقيم",
  "in house": "مقيم",
  "pending confirmation": "بانتظار التأكيد",
  pending: "قيد الانتظار",
  cancelled: "ملغي",
  canceled: "ملغي",
  completed: "مكتمل",
  "checked out": "تمت المغادرة",
});

const receiptStatus = (value) => {
  const en = String(value || "Confirmed").trim() || "Confirmed";
  const normalized = en.toLowerCase();
  return {
    en,
    ar: STATUS_TRANSLATIONS[normalized] || "حالة الحجز",
    positive: ["confirmed", "inhouse", "in house", "completed"].includes(
      normalized
    ),
  };
};

const CODE39_PATTERNS = Object.freeze({
  0: "nnnwwnwnn",
  1: "wnnwnnnnw",
  2: "nnwwnnnnw",
  3: "wnwwnnnnn",
  4: "nnnwwnnnw",
  5: "wnnwwnnnn",
  6: "nnwwwnnnn",
  7: "nnnwnnwnw",
  8: "wnnwnnwnn",
  9: "nnwwnnwnn",
  A: "wnnnnwnnw",
  B: "nnwnnwnnw",
  C: "wnwnnwnnn",
  D: "nnnnwwnnw",
  E: "wnnnwwnnn",
  F: "nnwnwwnnn",
  G: "nnnnnwwnw",
  H: "wnnnnwwnn",
  I: "nnwnnwwnn",
  J: "nnnnwwwnn",
  K: "wnnnnnnww",
  L: "nnwnnnnww",
  M: "wnwnnnnwn",
  N: "nnnnwnnww",
  O: "wnnnwnnwn",
  P: "nnwnwnnwn",
  Q: "nnnnnnwww",
  R: "wnnnnnwwn",
  S: "nnwnnnwwn",
  T: "nnnnwnwwn",
  U: "wwnnnnnnw",
  V: "nwwnnnnnw",
  W: "wwwnnnnnn",
  X: "nwnnwnnnw",
  Y: "wwnnwnnnn",
  Z: "nwwnwnnnn",
  "-": "nwnnnnwnw",
  ".": "wwnnnnwnn",
  " ": "nwwnnnwnn",
  $: "nwnwnwnnn",
  "/": "nwnwnnnwn",
  "+": "nwnnnwnwn",
  "%": "nnnwnwnwn",
  "*": "nwnnwnwnn",
});

const barcodeSvg = (value) => {
  const normalized = String(value || "N/A")
    .toUpperCase()
    .replace(/[^0-9A-Z. $/+%-]/g, "-")
    .slice(0, 32);
  const encoded = `*${normalized}*`;
  let cursor = 10;
  const bars = [];
  encoded.split("").forEach((character) => {
    const pattern = CODE39_PATTERNS[character] || CODE39_PATTERNS["-"];
    pattern.split("").forEach((widthCode, index) => {
      const width = widthCode === "w" ? 3 : 1;
      if (index % 2 === 0) {
        bars.push(`<rect x="${cursor}" y="2" width="${width}" height="40"/>`);
      }
      cursor += width;
    });
    cursor += 1;
  });
  const width = cursor + 9;
  return `<svg class="receipt-barcode" viewBox="0 0 ${width} 44" preserveAspectRatio="none" role="img" aria-label="Barcode for ${escapeHtml(
    normalized
  )}"><rect width="${width}" height="44" fill="#fff"/><g fill="#111">${bars.join(
    ""
  )}</g></svg>`;
};

const money = (value) =>
  new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(safeNumber(value));

const bilingualLabel = (en, ar) =>
  `<span class="bilingual-label"><strong>${escapeHtml(
    en
  )}</strong><span dir="rtl" lang="ar">${escapeHtml(ar)}</span></span>`;

const buildOfficialReceiptView = (reservationData = {}, hotelInfo = {}) => {
  const customer =
    reservationData?.customer_details || reservationData?.customerDetails || {};
  const nights = calculateNights(
    reservationData?.checkin_date,
    reservationData?.checkout_date
  );
  const rooms = buildRoomRows(reservationData, hotelInfo, nights);
  const payment = derivePayment(reservationData);
  const status = receiptStatus(
    reservationData?.reservation_status || reservationData?.state
  );
  const hotelName = titleCase(
    hotelInfo?.hotelName ||
      reservationData?.hotelName ||
      reservationData?.hotelId?.hotelName ||
      "Hotel"
  );
  const hotelNameArabic =
    hotelInfo?.hotelName_OtherLanguage ||
    reservationData?.hotelName_OtherLanguage ||
    reservationData?.hotelId?.hotelName_OtherLanguage ||
    "";
  const supplierName = String(
    reservationData?.supplierData?.supplierName ||
      reservationData?.supplierData?.suppliedBy ||
      hotelInfo?.suppliedBy ||
      hotelInfo?.belongsTo?.name ||
      reservationData?.belongsTo?.name ||
      "N/A"
  ).trim();
  const supplierBookingNo = String(
    reservationData?.supplierData?.suppliedBookingNo ||
      reservationData?.supplierData?.supplierBookingNo ||
      reservationData?.supplierData?.supplierBookingNumber ||
      reservationData?.confirmation_number ||
      "N/A"
  ).trim();
  const bookingNo = String(
    reservationData?.confirmation_number || "N/A"
  ).trim();
  const rawNationality = String(customer?.nationality || "N/A").trim();
  const countryCode = countryCodeFromNationality(rawNationality);
  const nationality = displayNationality(rawNationality, countryCode);
  const totalRooms = rooms.reduce((sum, room) => sum + room.count, 0);
  const guests = Number(reservationData?.total_guests || 0) || totalRooms || 1;
  return {
    bookingDate: formatDate(
      reservationData?.createdAt || reservationData?.booked_at
    ),
    bookingNo,
    bookingSource: String(
      reservationData?.booking_source || "Jannatbooking.com"
    ).trim(),
    checkin: {
      en: formatDate(reservationData?.checkin_date),
      ar: formatDate(reservationData?.checkin_date, "ar-EG"),
    },
    checkout: {
      en: formatDate(reservationData?.checkout_date),
      ar: formatDate(reservationData?.checkout_date, "ar-EG"),
    },
    countryCode,
    flagDataUri: flagDataUri(countryCode),
    guestName: customer?.name || "Guest",
    guests,
    hotelName,
    hotelNameArabic,
    nationality,
    nights,
    payment,
    rooms,
    status,
    supplierBookingNo,
    supplierName,
  };
};

const renderOfficialReceiptHtml = (reservationData = {}, hotelInfo = {}) => {
  const view = buildOfficialReceiptView(reservationData, hotelInfo);
  const roomRows = view.rooms.length
    ? view.rooms
        .map(
          (room) => `
          <tr>
            <td class="large-value">${room.count}</td>
            <td><strong>${escapeHtml(room.englishName)}</strong>${
            room.arabicName
              ? `<span dir="rtl" lang="ar">${escapeHtml(
                  room.arabicName
                )}</span>`
              : ""
          }</td>
            <td>${room.rate > 0 ? `${money(room.rate)} SAR` : "N/A"}</td>
            <td>${room.total > 0 ? `${money(room.total)} SAR` : "N/A"}</td>
          </tr>`
        )
        .join("")
    : '<tr><td colspan="4">Room details are available from Jannat Booking support.</td></tr>';
  const flag = view.flagDataUri
    ? `<img class="nationality-flag" src="${
        view.flagDataUri
      }" alt="${escapeHtml(view.nationality)} flag" />`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Booking Receipt</title>
  <style>
    ${embeddedArabicFontCss}
    :root { --charcoal:#575757; --orange:#ff984b; --peach:#ffd2aa; --paper:#fffdf7; --gray:#dedede; --soft-gray:#f0f0f0; --green:#2f8c4b; --soft-green:#e4f7cb; }
    * { box-sizing:border-box; }
    html, body { margin:0; padding:0; background:#fff; color:#101010; font-family:Arial,Tahoma,"Noto Sans Arabic",sans-serif; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
    .receipt { width:100%; max-width:1080px; margin:0 auto; background:var(--paper); font-size:14px; line-height:1.2; overflow:hidden; }
    [lang="ar"] { font-family:"Jannat Noto Arabic",Tahoma,Arial,sans-serif; }
    .receipt-hero { min-height:158px; padding:28px 48px 24px; display:flex; align-items:center; justify-content:space-between; gap:28px; background:var(--charcoal); color:#fff; }
    .brand-lockup { min-width:250px; text-align:center; line-height:1; }
    .brand-name { font-size:58px; font-weight:300; letter-spacing:2px; }
    .brand-site { margin-top:-1px; color:var(--orange); font-size:22px; font-weight:800; }
    .receipt-title { display:grid; text-align:center; color:var(--orange); line-height:1.03; }
    .receipt-title strong { font-size:38px; }
    .receipt-title span { font-size:34px; font-weight:800; }
    .receipt-accent { height:23px; background:var(--peach); }
    .hotel-banner { min-height:74px; display:grid; place-content:center; text-align:center; background:var(--charcoal); color:#fff; font-size:27px; line-height:1.05; }
    .hotel-banner [lang="ar"] { font-size:23px; font-weight:700; }
    .booking-band { min-height:82px; display:grid; place-content:center; text-align:center; background:var(--gray); font-size:18px; line-height:1.55; }
    .receipt-body { padding:24px 34px 0; }
    .identity-layout { display:grid; grid-template-columns:minmax(0,2.35fr) minmax(260px,.95fr); gap:28px; }
    .supplier-lines { padding:8px 4px 17px; font-size:18px; line-height:1.45; }
    .section-heading { min-height:62px; display:grid; place-content:center; text-align:center; border-top:3px solid #151515; border-bottom:3px solid #151515; background:#ffe9d5; font-size:23px; line-height:1.05; }
    .section-heading [lang="ar"] { font-size:22px; font-weight:800; }
    .guest-card,.nationality-card { display:grid; grid-template-columns:auto 12px minmax(0,1fr) auto; align-items:center; gap:10px; background:var(--soft-gray); }
    .guest-card { min-height:64px; margin:12px 3px 0; padding:10px 26px; }
    .guest-name { font-size:21px; font-weight:800; overflow-wrap:anywhere; }
    .bilingual-label { display:grid; text-align:center; line-height:1.02; }
    .bilingual-label [lang="ar"] { font-weight:800; }
    .detail-colon { font-size:26px; font-weight:800; }
    .confirmation-panel { display:grid; align-content:start; gap:10px; }
    .confirmation-title { text-align:center; font-size:25px; font-weight:900; }
    .confirmation-box { min-height:112px; padding:8px 16px 7px; display:grid; place-items:center; border-top:2px solid #1a1a1a; border-bottom:2px solid #1a1a1a; background:#f1f3f5; }
    .confirmation-number { color:#19723a; font-size:clamp(18px,2.7vw,30px); font-weight:900; line-height:1; white-space:nowrap; }
    .receipt-barcode { width:100%; height:42px; display:block; }
    .nationality-card { min-height:58px; padding:8px 18px; font-size:17px; }
    .nationality-flag { width:34px; height:25px; object-fit:cover; box-shadow:0 0 0 1px rgba(0,0,0,.15); }
    table { width:100%; border-collapse:collapse; }
    .stay-table { margin-top:16px; table-layout:fixed; }
    .stay-table th,.stay-table td { border:2px solid #1a1a1a; padding:7px 8px; text-align:center; vertical-align:middle; }
    .stay-table th { background:#fff; }
    .stay-table thead th:first-child,.stay-table tbody th:first-child { width:17%; }
    .stay-table thead td,.stay-table tbody td:nth-child(2) { width:23%; }
    .stay-table td>span,.stay-table td>strong { display:block; }
    .large-value { font-size:21px; font-weight:800; }
    .status-positive { background:var(--soft-green); box-shadow:inset 0 -4px 0 #63c77f; }
    .status-neutral { background:#fff2ce; }
    .status-positive span,.status-positive strong,.status-neutral span,.status-neutral strong { display:block; }
    .finance-layout { margin-top:30px; padding-top:8px; border-top:3px solid #111; display:grid; grid-template-columns:minmax(0,2.35fr) minmax(260px,.95fr); gap:28px; align-items:start; }
    .rooms-table { table-layout:fixed; }
    .rooms-table th,.rooms-table td { padding:8px; text-align:center; vertical-align:middle; }
    .rooms-table th { font-size:13px; }
    .rooms-table th:first-child { width:17%; }
    .rooms-table th:nth-child(2) { width:47%; }
    .rooms-table th:nth-child(3),.rooms-table th:nth-child(4) { width:18%; }
    .rooms-table td { background:var(--soft-gray); border:7px solid var(--paper); overflow-wrap:anywhere; }
    .rooms-table td span,.rooms-table td strong { display:block; }
    .booking-source { padding:3px 8px 10px; color:#474747; text-align:right; font-size:12px; }
    .payment-method { margin:16px auto 0; max-width:600px; min-height:74px; display:grid; grid-template-columns:1.15fr 1fr; text-align:center; }
    .payment-method>div { display:grid; place-content:center; padding:10px; }
    .payment-method>div:first-child { background:var(--charcoal); color:#fff; font-size:20px; }
    .payment-method>div:last-child { background:var(--soft-green); color:var(--green); font-size:26px; }
    .payment-method>div:last-child span,.payment-method>div:last-child strong { display:block; }
    .payment-unpaid>div:last-child { background:#f2f2f2; color:#4a4a4a; }
    .payment-pending>div:last-child,.payment-partial>div:last-child { background:#fff0d5; color:#b1661f; }
    .payment-details { display:grid; gap:8px; }
    .payment-heading { min-height:76px; display:grid; place-content:center; text-align:center; background:var(--charcoal); color:#fff; font-size:23px; }
    .payment-heading span,.payment-heading strong { display:block; }
    .payment-row { min-height:61px; padding:8px 14px; display:grid; grid-template-columns:minmax(0,1fr) 10px auto; align-items:center; gap:7px; background:#d4d4d4; }
    .payment-row>strong { font-size:23px; white-space:nowrap; }
    .payment-deposit>strong,.payment-remaining>strong { color:var(--green); }
    .receipt-footer { min-height:83px; margin-top:12px; padding:15px 28px; display:grid; place-content:center; text-align:center; background:#080808; color:#fff; font-size:16px; line-height:1.55; }
    @page { size:A4; margin:0; }
    @media print { .receipt { max-width:none; width:111.112%; zoom:.9; } .rooms-table tr,.payment-details,.payment-method { break-inside:avoid; page-break-inside:avoid; } }
  </style>
</head>
<body>
  <article class="receipt">
    <header class="receipt-hero">
      <div class="brand-lockup"><div class="brand-name">JANNAT</div><div class="brand-site">Booking.com</div></div>
      <div class="receipt-title"><strong>Booking Receipt</strong><span dir="rtl" lang="ar">فاتورة الحجز</span></div>
    </header>
    <div class="receipt-accent"></div>
    <section class="hotel-banner"><div>${escapeHtml(view.hotelName)}</div>${
    view.hotelNameArabic
      ? `<div dir="rtl" lang="ar">${escapeHtml(view.hotelNameArabic)}</div>`
      : ""
  }</section>
    <section class="booking-band"><div><strong>Booking No:</strong> <bdi dir="ltr">${escapeHtml(
      view.bookingNo
    )}${
    view.supplierBookingNo !== view.bookingNo
      ? ` / ${escapeHtml(view.supplierBookingNo)}`
      : ""
  }</bdi></div><div><strong>Booking Date:</strong> ${escapeHtml(
    view.bookingDate
  )}</div></section>
    <main class="receipt-body">
      <div class="identity-layout">
        <div class="identity-main">
          <div class="supplier-lines"><div><strong>Supplied By:</strong> ${escapeHtml(
            view.supplierName
          )}</div><div><strong>Supplier Booking No:</strong> <bdi dir="ltr">${escapeHtml(
    view.supplierBookingNo
  )}</bdi></div></div>
          <div class="section-heading"><strong>Reservation Details</strong><span dir="rtl" lang="ar">تفاصيل الحجز</span></div>
          <div class="guest-card">${bilingualLabel(
            "Guest Name",
            "اسم الضيف"
          )}<span class="detail-colon">:</span><span class="guest-name">${escapeHtml(
    view.guestName
  )}</span></div>
        </div>
        <aside class="confirmation-panel">
          <div class="confirmation-title" dir="rtl" lang="ar">رقم حجز الفندق</div>
          <div class="confirmation-box"><strong>Hotel Confirmation No.</strong><span class="confirmation-number">${escapeHtml(
				view.bookingNo
			  )}</span>${barcodeSvg(view.bookingNo)}</div>
          <div class="nationality-card">${bilingualLabel(
            "Nationality",
            "الجنسية"
          )}<span class="detail-colon">:</span><span>${escapeHtml(
    view.nationality
  )}</span>${flag}</div>
        </aside>
      </div>
      <table class="stay-table">
        <thead><tr><th>${bilingualLabel(
          "Check-in Date",
          "تاريخ الوصول"
        )}</th><td><strong>${escapeHtml(
    view.checkin.en
  )}</strong><span dir="rtl" lang="ar">${escapeHtml(
    view.checkin.ar
  )}</span></td><th>${bilingualLabel(
    "Guests",
    "عدد الضيوف"
  )}</th><th>${bilingualLabel("Nights", "الليالي")}</th><th>${bilingualLabel(
    "Booking Status",
    "حالة الحجز"
  )}</th></tr></thead>
        <tbody><tr><th>${bilingualLabel(
          "Checkout Date",
          "تاريخ المغادرة"
        )}</th><td><strong>${escapeHtml(
    view.checkout.en
  )}</strong><span dir="rtl" lang="ar">${escapeHtml(
    view.checkout.ar
  )}</span></td><td class="large-value">${
    view.guests
  }</td><td class="large-value">${view.nights}</td><td class="${
    view.status.positive ? "status-positive" : "status-neutral"
  }"><strong dir="rtl" lang="ar">${escapeHtml(
    view.status.ar
  )}</strong><span>${escapeHtml(
    titleCase(view.status.en)
  )}</span></td></tr></tbody>
      </table>
      <div class="finance-layout">
        <section class="rooms-section">
          <table class="rooms-table"><thead><tr><th>${bilingualLabel(
            "No. of rooms",
            "عدد الغرف"
          )}</th><th>${bilingualLabel(
    "Room Type",
    "نوع الغرفة"
  )}</th><th>${bilingualLabel(
    "Night price",
    "سعر الليلة"
  )}</th><th>${bilingualLabel(
    "Total price",
    "إجمالي السعر"
  )}</th></tr></thead><tbody>${roomRows}</tbody></table>
          <div class="booking-source"><strong>Booking Source:</strong> ${escapeHtml(
            view.bookingSource
          )}</div>
          <div class="payment-method payment-${escapeHtml(
            view.payment.method.tone
          )}"><div>${bilingualLabel(
    "Payment Method",
    "طريقة الدفع"
  )}</div><div><strong>${escapeHtml(
    view.payment.method.en
  )}</strong><span dir="rtl" lang="ar">${escapeHtml(
    view.payment.method.ar
  )}</span></div></div>
        </section>
        <aside class="payment-details">
          <div class="payment-heading"><strong>Payment Details</strong><span dir="rtl" lang="ar">تفاصيل الدفع</span></div>
          <div class="payment-row payment-total">${bilingualLabel(
            "Total Amount",
            "السعر الإجمالي"
          )}<span>:</span><strong>${money(
    view.payment.total
  )} SAR</strong></div>
          <div class="payment-row payment-deposit">${bilingualLabel(
            "Deposit",
            "عربون"
          )}<span>:</span><strong>${money(view.payment.paid)} SAR</strong></div>
          <div class="payment-row payment-remaining">${bilingualLabel(
            "Remaining Due",
            "المبلغ المتبقي"
          )}<span>:</span><strong>${money(
    view.payment.remaining
  )} SAR</strong></div>
        </aside>
      </div>
    </main>
    <footer class="receipt-footer"><div>Many Thanks For Staying With Us At <strong>${escapeHtml(
      view.hotelName
    )}</strong></div><div>For Better Rates Next Time, Please Check Jannatbooking.com</div></footer>
  </article>
</body>
</html>`;
};

module.exports = {
  buildOfficialReceiptView,
  countryCodeFromNationality,
  displayNationality,
  renderOfficialReceiptHtml,
};
