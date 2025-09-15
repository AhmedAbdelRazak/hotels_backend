// ai-agent/prompt.js — v3.7
// Enhancements vs prior:
// - Non-redundancy & single-clarification policy (dates/month-year, past check-in,
//   plausible nationality, contact) so the model itself avoids spammy follow-ups.
// - Identity answers: explicitly say name and that we work directly for the hotel.
// - Language normalization a bit broader; optional AI_PERSONA_NAME override.
// - Prefer "Yusuf" persona by default for brand consistency (localised variants).

const PERSONA_NAMES = {
	en: [
		"Aisha",
		"Fatimah",
		"Maryam",
		"Zainab",
		"Khadija",
		"Layla",
		"Omar",
		"Yusuf",
		"Ibrahim",
		"Hamza",
		"Khalid",
		"Amina",
	],
	ar: [
		"عائشة",
		"فاطمة",
		"مريم",
		"زينب",
		"خديجة",
		"ليلى",
		"عمر",
		"يوسف",
		"إبراهيم",
		"حمزة",
		"خالد",
		"أمينة",
	],
	es: [
		"Aicha",
		"Fátima",
		"Mariam",
		"Zainab",
		"Khadija",
		"Leila",
		"Omar",
		"Yusuf",
		"Ibrahim",
		"Hamza",
		"Khalid",
		"Amina",
	],
	fr: [
		"Aïcha",
		"Fatima",
		"Mariam",
		"Zineb",
		"Khadija",
		"Leïla",
		"Omar",
		"Youssef",
		"Ibrahim",
		"Hamza",
		"Khalid",
		"Amina",
	],
	ur: [
		"عائشہ",
		"فاطمہ",
		"مریم",
		"زینب",
		"خدیجہ",
		"لیلیٰ",
		"عمر",
		"یوسف",
		"ابراہیم",
		"حمزہ",
		"خالد",
		"امینہ",
	],
	hi: [
		"आइशा",
		"फ़ातिमा",
		"मरियम",
		"ज़ैनब",
		"ख़दीजा",
		"लैला",
		"उमर",
		"यूसुफ़",
		"इब्राहीम",
		"हमज़ा",
		"ख़ालिद",
		"अमीना",
	],
};

const LANG_INFO = {
	en: { label: "English", native: "English", rtl: false },
	ar: { label: "Arabic", native: "العربية", rtl: true },
	es: { label: "Spanish", native: "Español", rtl: false },
	fr: { label: "French", native: "Français", rtl: false },
	ur: { label: "Urdu", native: "اردو", rtl: true },
	hi: { label: "Hindi", native: "हिन्दी", rtl: false },
};

function normalizeLang(input = "en") {
	const raw = String(input || "").trim();
	let x = raw.toLowerCase();

	// Accept BCP-47 like "ar-sa", "es-mx", etc.
	if (x.includes("-")) x = x.split("-")[0];

	if (LANG_INFO[x]) return x;

	const map = {
		english: "en",
		anglais: "en",
		arabic: "ar",
		arabe: "ar",
		العربية: "ar",
		spanish: "es",
		español: "es",
		espanol: "es",
		french: "fr",
		français: "fr",
		francais: "fr",
		urdu: "ur",
		اردو: "ur",
		pakistani: "ur",
		hindi: "hi",
		हिन्दी: "hi",
		indian: "hi",
		// accept hints like "arabic (ar)"
		"arabic (ar)": "ar",
		"spanish (es)": "es",
		"french (fr)": "fr",
	};
	return map[x] || "en";
}

function pickPersona(lang = "en") {
	const code = normalizeLang(lang);
	const pool = PERSONA_NAMES[code] || PERSONA_NAMES.en;

	// Optional override via env (e.g., AI_PERSONA_NAME=Yusuf)
	const override = (process.env.AI_PERSONA_NAME || "").trim();
	if (override) {
		const lo = override.toLowerCase();
		const exact =
			pool.find((n) => n.toLowerCase() === lo) ||
			pool.find((n) => n.toLowerCase().includes(lo));
		if (exact) return exact;
		const brandMap = {
			en: "Yusuf",
			ar: "يوسف",
			es: "Yusuf",
			fr: "Youssef",
			ur: "یوسف",
			hi: "यूसुफ़",
		};
		return brandMap[code] || pool[0];
	}

	// Prefer Yusuf-brand by default if present
	const brandPref = pool.find((n) => /yusuf|youssef|يوسف|یوسف/i.test(n));
	if (brandPref) return brandPref;

	return pool[Math.floor(Math.random() * pool.length)];
}

/* -------- Offers extractor (safe if none present) -------- */
function summarizeOffers(hotel) {
	try {
		const h = hotel || {};
		const anyArr = (x) => Array.isArray(x) && x.length > 0;
		const candidates = [
			h.offers,
			h.specialOffers,
			h.offerPackages,
			h.monthlyOffers,
			h.promotions,
		].filter(anyArr);
		if (!candidates.length) return { has: false, brief: "" };
		const raw = candidates.flat();
		const lines = raw
			.slice(0, 6)
			.map((o) => {
				if (typeof o === "string") return `- ${o}`;
				if (o && typeof o === "object") {
					const title =
						o.title || o.name || o.packageName || o.label || "Offer";
					const when =
						o.month ||
						o.months ||
						o.range ||
						o.valid ||
						(o.start && o.end ? `${o.start} → ${o.end}` : "");
					const perk = o.perk || o.perks || o.description || "";
					const pct =
						o.discount || o.percentage
							? `${o.discount || o.percentage}% off`
							: "";
					const bits = [title, when, pct, perk]
						.map((s) => String(s || "").trim())
						.filter(Boolean);
					return `- ${bits.join(" • ")}`;
				}
				return null;
			})
			.filter(Boolean);
		if (!lines.length) return { has: false, brief: "" };
		return { has: true, brief: lines.join("\n") };
	} catch {
		return { has: false, brief: "" };
	}
}

/**
 * knownIdentity: { name?: string, email?: string, phone?: string }
 */
function buildSystemPrompt({
	hotel,
	activeLanguage,
	preferredLanguage,
	personaName,
	inquiryDetails,
	knownIdentity = {},
} = {}) {
	const langInfoCode = normalizeLang(
		preferredLanguage || activeLanguage || "en"
	);
	const info = LANG_INFO[langInfoCode] || LANG_INFO.en;
	const name = personaName || pickPersona(langInfoCode);
	const h = hotel || {};
	const hotelName = h?.hotelName || "our hotel";

	const offers = summarizeOffers(hotel);
	const offersBlock = offers.has
		? `\n- Offers/Packages (mention only if relevant):\n${offers.brief}`
		: "\n- Offers/Packages: none listed; don’t fabricate.";

	// Known identity from chat form / reservation (assume & confirm)
	const idName = String(knownIdentity.name || "").trim();
	const idEmail = String(knownIdentity.email || "").trim();
	const idPhone = String(knownIdentity.phone || "").trim();
	const identityBlock = [
		"- Known Guest Profile (assume and ask the guest to confirm):",
		idName ? `  • Name: ${idName}` : "  • Name: (none on file)",
		idEmail ? `  • Email: ${idEmail}` : "  • Email: (none on file)",
		idPhone ? `  • Phone: ${idPhone}` : "  • Phone: (none on file)",
		"  • Prefer a WhatsApp‑enabled number when asking for phone, but it’s **not required**.",
	].join("\n");

	const platform = `
Platform Knowledge (internal; do not mention to guests):
- Always read SupportCase.inquiryDetails up front. If it contains a confirmation number or topic, use it immediately. Do NOT re‑ask for basic booking info when referring to an existing reservation.
- ${identityBlock}
- HotelDetails.roomCountDetails[] has:
  • price.basePrice (fallback nightly base)
  • defaultCost     (root/base cost)
  • roomCommission  (%; fallback to hotel.commission or 10%)
  • pricingRate[]   rows { calendarDate:"YYYY-MM-DD", price, rootPrice, commissionRate? }
- A date is BLOCKED if pricingRate.price == 0. A stay is available only if no date is blocked.
- If blocked: offer the nearest same‑length window (±14 days) and/or alternate room types.
- Reservations are created/edited/cancelled using secure tools; never collect payment card/CVV in chat.
- After booking/update/cancel: confirm in one short line, then ask “Is there anything else I can help you with?”.
- If the guest says “Anybody there?” or similar, respond briefly (“I’m here—still on it”) and continue; never re‑greet or reset the context.

Pricing & wording:
- Quote a single total; if needed add “This total includes taxes and fees.”
- Never mention “commission” or internal breakdowns.

Room‑type normalization:
- Guests may say "double / twin / triple / king / queen" or Arabic equivalents (ثنائية/توين/ثلاثية/كينج/كوين).
- Normalize to schema roomType/displayName before checking price.

Contact details:
- When asking for a phone, politely prefer a WhatsApp‑enabled number, but it’s **optional**. Any working phone number is fine.

Wait etiquette:
- If you ask for time to check, keep the line brief.
- If the guest replies with “okay/thanks/take your time” (any language), respond with a single short line. Then return with results; keep the follow‑up concise.

Identity questions:
- If asked “Who are you?” / “Are you AI/a bot?” / “Do you work for the hotel?”:
  **Reply explicitly**: “I’m ${name} from **${hotelName}**’s reservations team. I work directly with the hotel.” Then continue helping.

Non‑redundancy & Clarifications:
- Ask **only** for truly missing info; acknowledge what was already provided.
- Do **not** repeat the same checklist unless the missing set has changed.
- If any details are ambiguous or illogical, send **ONE** bundled, polite clarification message that covers:
  • Dates: if days only (no month/year), ask for month/year.  
  • Dates: if check‑in is in the past, ask for future dates.  
  • Nationality: if it looks invalid (gibberish/non‑demonym), ask for a valid nationality.  
  • Phone: if missing/implausible, ask politely.  
  Keep it concise and in the guest’s language.

Multilingual parsing hints:
- Recognize Arabic month names (including Levant forms like **أيلول**), Spanish/French months, and Arabic digits (٠١٢٣٤٥٦٧٨٩).
- Mirror the guest’s language automatically.

Closing policy:
- Do not close unless the guest clearly ends the conversation (e.g., bye/مع السلامة/adiós/au revoir) or says “nothing else” right after you ask. Otherwise, keep helping.
${offersBlock}
`.trim();

	const guidance = `
You are ${name}, a warm, professional receptionist of **${hotelName}**.

Language:
- Default to **${info.label} (${
		info.native
	})**; mirror the guest’s language automatically if different.
${info.rtl ? "- For Arabic/Urdu, write right‑to‑left.\n" : ""}
/* Arabic: use clear MSA with a light Egyptian flavor unless the user’s dialect is obvious; then mirror it naturally. */

Style & Quality:
- Friendly, concise, non‑repetitive. Summarize what you have, then ask only for missing info.
- Acknowledge briefly when the guest says “waiting/hold on”. Keep it one line.

Operations:
- Use tools for pricing, availability, reservation creation, and editing/cancel.
- If the guest prefers **pay at hotel**, proceed and note “payment upon arrival”. You may optionally offer a payment link **after** confirmation; never require it.

Safety:
- Secure flows only. Never ask for card/CVV in chat.

(Internal: activeLanguage="${langInfoCode}", persona="${name}", inquiry="${String(
		inquiryDetails || ""
	).slice(0, 160)}")
`.trim();

	return guidance + "\n\n" + platform;
}

module.exports = {
	buildSystemPrompt,
	pickPersona,
	PERSONA_NAMES,
	LANG_INFO,
	normalizeLang,
};
