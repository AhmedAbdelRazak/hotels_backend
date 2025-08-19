/**
 * whatsappsender.js — Jannat Booking (verbose edition)
 *
 * WhatsApp sending utilities:
 *  - Deterministic E.164 normalization (google-libphonenumber + country mapping)
 *  - Optional OpenAI fallback to pick the right country calling code for messy inputs
 *  - Twilio Content Template sender
 *  - Verbose, structured logging + dry run option
 *
 * Required ENV:
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   TWILIO_PHONE_NUMBER            // e.g. +14155552671 (your approved WA sender)
 *   TWILIO_CSID_RESERVATION_CONFIRMATION
 *   TWILIO_CSID_VERIFICATION_LINK
 *   TWILIO_CSID_PAYMENT_LINK
 *   TWILIO_CSID_RESERVATION_UPDATE
 *   TWILIO_CSID_ADMIN_NOTIFICATION
 *
 * Optional ENV:
 *   CHATGPT_API_TOKEN              // enables OpenAI fallback
 *   WHATSAPP_VERBOSE=true|false    // default true
 *   WHATSAPP_DRY_RUN=true|false    // default false (when true, no Twilio calls)
 *   WHATSAPP_LOG_PII=true|false    // default false (mask phones in logs)
 */

const twilio = require("twilio");
const countries = require("i18n-iso-countries");
const libphone = require("google-libphonenumber");
const OpenAI = require("openai");

// Models (for owner/agent lookup)
const User = require("../models/user");
const HotelDetails = require("../models/hotel_details");

// ---------------- Logging helpers ----------------
const VERBOSE =
	String(process.env.WHATSAPP_VERBOSE ?? "true").toLowerCase() === "true";
const DRY_RUN =
	String(process.env.WHATSAPP_DRY_RUN ?? "false").toLowerCase() === "true";
const LOG_PII =
	String(process.env.WHATSAPP_LOG_PII ?? "false").toLowerCase() === "true";
const LOG_PREFIX = "[WA]";

function log(...args) {
	if (VERBOSE) console.log(LOG_PREFIX, ...args);
}
function warn(...args) {
	console.warn(LOG_PREFIX, ...args);
}
function error(...args) {
	console.error(LOG_PREFIX, ...args);
}

function redactPhone(p) {
	if (!p || LOG_PII) return p;
	// Keep + and last 4 digits
	const s = String(p);
	return s.replace(/(\+?\d{0,3})\d+(?=\d{4}$)/, "$1••••••").replace(/\s+/g, "");
}

function redactSid(sid) {
	if (!sid) return sid;
	return sid.length > 8 ? `${sid.slice(0, 4)}…${sid.slice(-4)}` : sid;
}

function kv(obj) {
	try {
		return JSON.stringify(obj);
	} catch {
		return String(obj);
	}
}

// ---------------- Country / phone init ----------------
countries.registerLocale(require("i18n-iso-countries/langs/en.json"));
countries.registerLocale(require("i18n-iso-countries/langs/ar.json"));
countries.registerLocale(require("i18n-iso-countries/langs/fr.json"));

const phoneUtil = libphone.PhoneNumberUtil.getInstance();
const PNF = libphone.PhoneNumberFormat;

function alpha2CodesMap() {
	return countries.getAlpha2Codes() || {};
}
function isValidISO2(code) {
	if (!code) return false;
	const up = String(code).toUpperCase();
	const map = alpha2CodesMap();
	return !!map[up];
}

// ---------------- Twilio init ----------------
const fromNumber = String(process.env.TWILIO_PHONE_NUMBER || "").replace(
	/^\+?/,
	"+"
);
const FROM_WHATSAPP = `whatsapp:${fromNumber}`;
const twilioEnvOk =
	!!process.env.TWILIO_ACCOUNT_SID &&
	!!process.env.TWILIO_AUTH_TOKEN &&
	!!fromNumber &&
	fromNumber.startsWith("+");
let twilioClient = null;

if (twilioEnvOk) {
	twilioClient = twilio(
		process.env.TWILIO_ACCOUNT_SID,
		process.env.TWILIO_AUTH_TOKEN
	);
} else {
	warn("Twilio env incomplete: messages will fail unless DRY_RUN is true.", {
		hasSID: !!process.env.TWILIO_ACCOUNT_SID,
		hasToken: !!process.env.TWILIO_AUTH_TOKEN,
		fromNumber: redactPhone(fromNumber),
	});
}

// Content Template SIDs
const TPL = {
	RESERVATION_CONFIRMATION: process.env.TWILIO_CSID_RESERVATION_CONFIRMATION,
	VERIFICATION_LINK: process.env.TWILIO_CSID_VERIFICATION_LINK,
	PAYMENT_LINK: process.env.TWILIO_CSID_PAYMENT_LINK,
	RESERVATION_UPDATE: process.env.TWILIO_CSID_RESERVATION_UPDATE,
	ADMIN_NOTIFICATION: process.env.TWILIO_CSID_ADMIN_NOTIFICATION,
};

// ---------------- OpenAI init (optional) ----------------
const haveOpenAI = !!process.env.CHATGPT_API_TOKEN;
const openai = haveOpenAI
	? new OpenAI({ apiKey: process.env.CHATGPT_API_TOKEN })
	: null;

// ---------------- Startup summary ----------------
// (function startupSummary() {
// 	log("Starting WhatsApp module (verbose logging ENABLED).");
// 	log("Env summary:", {
// 		from: redactPhone(fromNumber),
// 		dryRun: DRY_RUN,
// 		verbose: VERBOSE,
// 		logPII: LOG_PII,
// 		twilioEnvOk,
// 		haveOpenAI,
// 	});
// 	log("Templates:", {
// 		RESERVATION_CONFIRMATION: redactSid(TPL.RESERVATION_CONFIRMATION),
// 		VERIFICATION_LINK: redactSid(TPL.VERIFICATION_LINK),
// 		PAYMENT_LINK: redactSid(TPL.PAYMENT_LINK),
// 		RESERVATION_UPDATE: redactSid(TPL.RESERVATION_UPDATE),
// 		ADMIN_NOTIFICATION: redactSid(TPL.ADMIN_NOTIFICATION),
// 	});
// })();

// ---------------- Utilities ----------------
function firstWord(name) {
	if (!name) return "Guest";
	const s = String(name).trim();
	const parts = s.split(/\s+/);
	return parts[0] || "Guest";
}

// Arabic to English digits
function arDigitsToEn(str) {
	if (!str) return "";
	const map = {
		"٠": "0",
		"١": "1",
		"٢": "2",
		"٣": "3",
		"٤": "4",
		"٥": "5",
		"٦": "6",
		"٧": "7",
		"٨": "8",
		"٩": "9",
	};
	return String(str).replace(/[٠-٩]/g, (d) => map[d] || d);
}

function resolveRegion(nationalityRaw) {
	if (!nationalityRaw) return null;
	const n = String(nationalityRaw).trim();
	const up = n.toUpperCase();

	// Exact ISO2 (e.g., "DZ")
	if (up.length === 2 && isValidISO2(up)) return up;

	// ISO3 → ISO2 (e.g., "DZA" -> "DZ")
	if (up.length === 3) {
		const a2 = countries.alpha3ToAlpha2(up);
		if (a2 && isValidISO2(a2)) return a2;
	}

	// Try localized names (English, Arabic, French)
	return (
		countries.getAlpha2Code(n, "en") ||
		countries.getAlpha2Code(n, "ar") ||
		countries.getAlpha2Code(n, "fr") ||
		null
	);
}

async function openaiSuggestE164(nationality, cleanedDigitsMaybePlus) {
	if (!openai) return null;

	const prompt = `
Return ONLY a JSON object on a single line with the key "e164".
Given the user's nationality and a raw phone string, build an E.164 number using the country calling code that matches the nationality.
If impossible, return {"e164":"INVALID"}.
Nationality: ${nationality || ""}
Phone: ${cleanedDigitsMaybePlus || ""}
Example: {"e164":"+14155552671"}
`.trim();

	try {
		log("OpenAI fallback invoked.", {
			nationality,
			raw: cleanedDigitsMaybePlus,
		});
		const r = await openai.chat.completions.create({
			model: "gpt-4o-mini",
			temperature: 0,
			messages: [
				{ role: "system", content: "Respond with strict JSON only." },
				{ role: "user", content: prompt },
			],
		});
		const txt = r.choices?.[0]?.message?.content?.trim() || "";
		log("OpenAI raw response:", txt);
		const match = txt.match(/\{[\s\S]*\}/);
		const json = JSON.parse(match ? match[0] : txt);
		if (json && typeof json.e164 === "string" && json.e164.startsWith("+")) {
			return json.e164;
		}
	} catch (e) {
		warn("OpenAI fallback failed:", e?.message || e);
	}
	return null;
}

/**
 * Ensure E.164 format using deterministic parsing,
 * with OpenAI as a *last resort* to pick the country code.
 */
async function ensureE164Phone({
	nationality,
	rawPhone,
	fallbackRegion = "SA",
}) {
	log("ensureE164Phone: start", {
		nationality,
		rawPhone: redactPhone(rawPhone),
	});

	if (!rawPhone) {
		warn("ensureE164Phone: no rawPhone");
		return null;
	}

	let cleaned = arDigitsToEn(String(rawPhone))
		.replace(/[^\d+]/g, "") // keep digits and '+'
		.replace(/(?!^)\+/g, ""); // only allow a leading '+'

	// Convert 00 prefix → +
	if (cleaned.startsWith("00")) cleaned = `+${cleaned.slice(2)}`;

	const region = resolveRegion(nationality) || fallbackRegion || "SA";
	log("ensureE164Phone: cleaned + region", { cleaned, region });

	const candidates = [];
	if (cleaned.startsWith("+")) candidates.push(cleaned);
	candidates.push(cleaned);
	if (!cleaned.startsWith("+")) candidates.push(`+${cleaned}`);

	for (const cand of candidates) {
		try {
			const parsed = cand.startsWith("+")
				? phoneUtil.parse(cand)
				: phoneUtil.parse(cand, region);
			const valid = phoneUtil.isValidNumber(parsed);
			const formatted = valid ? phoneUtil.format(parsed, PNF.E164) : null;
			log("ensureE164Phone: candidate", {
				cand,
				valid,
				formatted: redactPhone(formatted),
			});
			if (valid) return formatted;
		} catch (e) {
			log("ensureE164Phone: parse fail", {
				cand,
				err: e?.message || String(e),
			});
		}
	}

	// Last resort: OpenAI picks a country code consistent with nationality
	const ai = await openaiSuggestE164(nationality, cleaned);
	if (ai) {
		try {
			const parsed = phoneUtil.parse(ai);
			if (phoneUtil.isValidNumber(parsed)) {
				const formatted = phoneUtil.format(parsed, PNF.E164);
				log("ensureE164Phone: OpenAI produced", {
					ai: redactPhone(ai),
					formatted: redactPhone(formatted),
				});
				return formatted;
			}
		} catch (e) {
			log("ensureE164Phone: OpenAI parse failed", {
				ai,
				err: e?.message || String(e),
			});
		}
	}

	warn("ensureE164Phone: unable to resolve E.164", {
		nationality,
		rawPhone: redactPhone(rawPhone),
	});
	return null;
}

// ---------------- Twilio sender for a Content Template ----------------
async function sendTemplate({ toE164, contentSid, variables, tag }) {
	const contentVariables = JSON.stringify(
		Object.fromEntries(
			Object.entries(variables || {}).map(([k, v]) => [
				String(k),
				String(v ?? ""),
			])
		)
	);

	const info = {
		tag: tag || "unspecified",
		to: redactPhone(toE164),
		contentSid: redactSid(contentSid),
		variables: variables, // short & clear (values are not sensitive)
		dryRun: DRY_RUN,
	};

	if (!toE164 || !contentSid) {
		warn("sendTemplate: skipped (missing to/contentSid).", info);
		return { skipped: true, reason: "missing to/contentSid" };
	}

	log("sendTemplate: prepared", info);

	if (DRY_RUN) {
		log("sendTemplate: DRY_RUN -> not sending to Twilio.", info);
		return { sid: "DRYRUN", status: "skipped", to: toE164, dryRun: true };
	}

	if (!twilioClient) {
		error("sendTemplate: Twilio client not initialized and DRY_RUN is false.");
		throw new Error("Twilio client not initialized");
	}

	try {
		const msg = await twilioClient.messages.create({
			from: `whatsapp:${fromNumber}`,
			to: `whatsapp:${toE164}`,
			contentSid,
			contentVariables,
		});
		log("sendTemplate: Twilio response", {
			sid: redactSid(msg.sid),
			status: msg.status,
			accountSid: redactSid(msg.accountSid),
			to: redactPhone(toE164),
			tag: info.tag,
		});
		return { sid: msg.sid, status: msg.status, to: toE164 };
	} catch (err) {
		error("sendTemplate: Twilio error", {
			tag: info.tag,
			to: redactPhone(toE164),
			contentSid: redactSid(contentSid),
			code: err?.code,
			status: err?.status,
			message: err?.message,
			moreInfo: err?.moreInfo,
		});
		throw err;
	}
}

// ---------------- High-level public functions ----------------

/**
 * Send reservation confirmation to the guest.
 * {{1}} = guest first name
 * {{2}} = reservation link
 */
async function waSendReservationConfirmation(reservation) {
	log("waSendReservationConfirmation: start", {
		confirmation: reservation?.confirmation_number,
		guest: reservation?.customer_details?.name,
		nationality: reservation?.customer_details?.nationality,
	});

	const guest = reservation?.customer_details || {};
	const to = await ensureE164Phone({
		nationality: guest.nationality,
		rawPhone: guest.phone,
	});
	if (!to) {
		warn("waSendReservationConfirmation: skipped (invalid guest phone).");
		return { skipped: true, reason: "invalid guest phone" };
	}

	const url = `${process.env.CLIENT_URL}/single-reservation/${reservation.confirmation_number}`;
	return sendTemplate({
		toE164: to,
		contentSid: TPL.RESERVATION_CONFIRMATION,
		variables: { 1: firstWord(guest.name), 2: url },
		tag: "reservation_confirmation",
	});
}

/**
 * Send verification link (Not Paid flow).
 * {{1}} = guest first name
 * {{2}} = verification link
 */
async function waSendVerificationLink(reservationOrShape, verificationUrl) {
	log("waSendVerificationLink: start", {
		guest: reservationOrShape?.customer_details?.name,
		nationality: reservationOrShape?.customer_details?.nationality,
		url: verificationUrl,
	});

	const guest = reservationOrShape?.customer_details || {};
	const to = await ensureE164Phone({
		nationality: guest.nationality,
		rawPhone: guest.phone,
	});
	if (!to) {
		warn("waSendVerificationLink: skipped (invalid guest phone).");
		return { skipped: true, reason: "invalid guest phone" };
	}

	return sendTemplate({
		toE164: to,
		contentSid: TPL.VERIFICATION_LINK,
		variables: { 1: firstWord(guest.name), 2: verificationUrl },
		tag: "verification_link",
	});
}

/**
 * Send a payment link to the guest.
 * {{1}} = guest first name
 * {{2}} = payment link
 */
async function waSendPaymentLink(reservationOrShape, paymentUrl) {
	log("waSendPaymentLink: start", {
		guest: reservationOrShape?.customer_details?.name,
		nationality: reservationOrShape?.customer_details?.nationality,
		url: paymentUrl,
	});

	const guest = reservationOrShape?.customer_details || {};
	const to = await ensureE164Phone({
		nationality: guest.nationality,
		rawPhone: guest.phone,
	});
	if (!to) {
		warn("waSendPaymentLink: skipped (invalid guest phone).");
		return { skipped: true, reason: "invalid guest phone" };
	}

	return sendTemplate({
		toE164: to,
		contentSid: TPL.PAYMENT_LINK,
		variables: { 1: firstWord(guest.name), 2: paymentUrl },
		tag: "payment_link",
	});
}

/**
 * Send reservation update to the guest.
 * {{1}} = guest first name
 * {{2}} = update text (you include link if desired)
 */
async function waSendReservationUpdate(reservation, updateText) {
	log("waSendReservationUpdate: start", {
		confirmation: reservation?.confirmation_number,
		guest: reservation?.customer_details?.name,
		nationality: reservation?.customer_details?.nationality,
		text: updateText,
	});

	const guest = reservation?.customer_details || {};
	const to = await ensureE164Phone({
		nationality: guest.nationality,
		rawPhone: guest.phone,
	});
	if (!to) {
		warn("waSendReservationUpdate: skipped (invalid guest phone).");
		return { skipped: true, reason: "invalid guest phone" };
	}

	return sendTemplate({
		toE164: to,
		contentSid: TPL.RESERVATION_UPDATE,
		variables: { 1: firstWord(guest.name), 2: String(updateText || "") },
		tag: "reservation_update",
	});
}

/**
 * Notify hotel owner/agent (belongsTo) and the platform owner.
 * admin_notification:
 *   {{1}} = recipient display ("<Owner Name>" or "Jannat Owners")
 *   {{2}} = confirmation_number
 */
async function waNotifyNewReservation(reservation) {
	log("waNotifyNewReservation: start", {
		confirmation: reservation?.confirmation_number,
		belongsTo: reservation?.belongsTo,
		hotelId: reservation?.hotelId,
	});

	const out = { owner: null, platform: null };

	// Owner/Agent (belongsTo)
	try {
		let ownerUser = null;
		if (reservation?.belongsTo) {
			ownerUser = await User.findById(reservation.belongsTo).lean();
			log(
				"waNotifyNewReservation: ownerUser",
				ownerUser
					? {
							_id: ownerUser._id,
							name: ownerUser.name,
							nationality: ownerUser.nationality,
							phone: redactPhone(ownerUser.phone),
					  }
					: { found: false }
			);
		}

		let ownerNationality = ownerUser?.nationality || ownerUser?.country || null;
		let ownerPhone = ownerUser?.phone || null;

		// Fallback: hotel record country/state
		if (!ownerNationality || !ownerPhone) {
			try {
				const hotel = await HotelDetails.findById(reservation.hotelId)
					.lean()
					.exec();
				if (!ownerNationality) {
					ownerNationality =
						hotel?.hotelCountry || hotel?.country || hotel?.hotelState || null;
				}
				log("waNotifyNewReservation: hotel fallback", {
					hotelId: reservation.hotelId,
					ownerNationality,
					ownerPhone: redactPhone(ownerPhone),
				});
			} catch (e) {
				warn("waNotifyNewReservation: hotel lookup failed", e?.message || e);
			}
		}

		if (ownerPhone) {
			const ownerTo = await ensureE164Phone({
				nationality: ownerNationality,
				rawPhone: ownerPhone,
			});
			if (ownerTo) {
				out.owner = await sendTemplate({
					toE164: ownerTo,
					contentSid: TPL.ADMIN_NOTIFICATION,
					variables: {
						1: ownerUser?.name || "Hotel Owner",
						2: reservation.confirmation_number,
					},
					tag: "admin_notification_owner",
				});
			} else {
				out.owner = { skipped: true, reason: "invalid owner phone" };
				warn(
					"waNotifyNewReservation: owner phone invalid after normalization."
				);
			}
		} else {
			out.owner = { skipped: true, reason: "missing owner phone" };
			warn("waNotifyNewReservation: missing owner phone.");
		}
	} catch (e) {
		error("waNotifyNewReservation: owner notify failed", e?.message || e);
		out.owner = { error: e?.message || String(e) };
	}

	// Platform owner (hard-coded)
	try {
		const platformTo = await ensureE164Phone({
			nationality: "US",
			rawPhone: "+19092223374",
		});
		if (platformTo) {
			out.platform = await sendTemplate({
				toE164: platformTo,
				contentSid: TPL.ADMIN_NOTIFICATION,
				variables: { 1: "Jannat Owners", 2: reservation.confirmation_number },
				tag: "admin_notification_platform",
			});
		} else {
			out.platform = { skipped: true, reason: "invalid platform phone" };
			warn(
				"waNotifyNewReservation: platform phone invalid after normalization."
			);
		}
	} catch (e) {
		error("waNotifyNewReservation: platform notify failed", e?.message || e);
		out.platform = { error: e?.message || String(e) };
	}

	log("waNotifyNewReservation: done", out);
	return out;
}

// ---------------- Self-test helper (optional) ----------------
/**
 * runSelfTest(sample?)
 *  - Validates phone normalization & "send" paths (honors DRY_RUN)
 *  - Provide your own reservation-like object or it will use a default.
 */
async function runSelfTest(sample) {
	const reservation = sample || {
		_id: "68a365d0d7de2f8b1a32f5dc",
		confirmation_number: "8109257883",
		belongsTo: "68992107e8d36376f71dd371",
		hotelId: "68992107e8d36376f71dd373",
		customer_details: {
			name: "وكالة جلنار للسياحة",
			email: "bhammaoui79@gmail.com",
			phone: "213661302303",
			nationality: "DZ",
		},
	};

	log("runSelfTest: BEGIN", { dryRun: DRY_RUN });

	const e164 = await ensureE164Phone({
		nationality: reservation.customer_details.nationality,
		rawPhone: reservation.customer_details.phone,
	});
	log("runSelfTest: normalized guest phone", { e164: redactPhone(e164) });

	const r1 = await waSendReservationConfirmation(reservation);
	const r2 = await waSendReservationUpdate(
		reservation,
		`Your reservation was updated. View: ${process.env.CLIENT_URL}/single-reservation/${reservation.confirmation_number}`
	);
	const r3 = await waNotifyNewReservation(reservation);

	log("runSelfTest: END", { confirmation: r1, update: r2, notify: r3 });
	return { confirmation: r1, update: r2, notify: r3 };
}

module.exports = {
	// utilities
	ensureE164Phone,

	// high-level senders
	waSendReservationConfirmation,
	waSendVerificationLink,
	waSendPaymentLink,
	waSendReservationUpdate,
	waNotifyNewReservation,

	// optional helper
	runSelfTest,
};
