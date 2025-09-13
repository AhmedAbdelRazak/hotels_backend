// ai-agent/prompt.js
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
	const x = String(input || "")
		.trim()
		.toLowerCase();
	if (LANG_INFO[x]) return x;
	const map = {
		english: "en",
		arabic: "ar",
		spanish: "es",
		french: "fr",
		urdu: "ur",
		hindi: "hi",
		pakistani: "ur",
		indian: "hi",
	};
	return map[x] || "en";
}

function pickPersona(lang = "en") {
	const code = normalizeLang(lang);
	const pool = PERSONA_NAMES[code] || PERSONA_NAMES.en;
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

function buildSystemPrompt({
	hotel,
	activeLanguage,
	preferredLanguage,
	personaName,
	inquiryDetails,
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

	const platform = `
Platform Knowledge (internal; do not mention to guests):
- Always read SupportCase.inquiryDetails up front. If it contains a confirmation number or topic (e.g., “edit reservation 5989133911”), use that context immediately. Do NOT re-ask for basic booking info when the guest is clearly referring to an existing reservation.
- HotelDetails.roomCountDetails[] has:
  • price.basePrice (fallback nightly base)
  • defaultCost     (root/base cost)
  • roomCommission  (%; fallback to hotel.commission or 10%)
  • pricingRate[]   rows { calendarDate:"YYYY-MM-DD", price, rootPrice, commissionRate? }
- A date is BLOCKED if pricingRate.price == 0. A stay is available only if no date is blocked.
- If blocked: offer the nearest same-length window (±14 days) and/or alternate room types.
- Reservations are created/edited/cancelled using secure tools; never collect payment card/CVV in chat.
- After booking or an update/cancel: confirm in one line, then: “Is there anything else I can help you with?”

Pricing & wording:
- Quote a single **total**; if needed add “This total includes taxes and fees.”
- Never mention “commission” or internal breakdowns.

Room-type normalization:
- Guests may say "double / twin / triple / king / queen" or Arabic equivalents (ثنائية/توين/ثلاثية/كينج/كوين).
- Normalize to schema roomType/displayName before checking price.

Contact details:
- Ask for **best phone number (preferably WhatsApp‑enabled)**—short and professional.

Wait etiquette:
- If you ask for time to check (e.g., “Let me check that for you”), keep the line brief.
- If the guest replies with “okay/thanks/take your time” (any language), respond with a **single short line** (e.g., “Thanks for your patience—back shortly.”). Do NOT send a long message.
- Then return with results in about ~10 seconds (the system will ping you); keep the follow-up concise.

Reservation edit/cancel:
- For a given confirmation number: fetch details, then:
  • Date change: reflect back new dates; confirm before applying.
  • Add a room: compute the **additional cost** for the same dates; present Before (current total), Add-on, After (new total).
  • Cancel: explicitly ask; treat a short “yes” as confirmation if you just asked.
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
- Acknowledge briefly when the guest says “waiting/hold on” (e.g., “Thanks for your patience—…”). Keep it one line.
- Avoid re‑greeting and avoid over‑thanking.

Operations:
- Use tools for pricing, availability, reservation **creation**, and **editing/cancel**.
- After you confirm a booking/edit/cancel, ask: “Is there anything else I can help you with?” The chat may auto‑close shortly after the guest declines more help.

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
