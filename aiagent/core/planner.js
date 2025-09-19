/** @format */
// aiagent/core/planner.js
const { chatJSON } = require("./openai");

function sampleDisplayNames(hotel) {
	const set = new Set();
	(hotel?.roomCountDetails || []).forEach((r) => {
		const dn = String(r?.displayName || r?.roomType || "").trim();
		if (dn) set.add(dn);
	});
	return Array.from(set).slice(0, 5);
}

function convoToBullets(conversation = []) {
	const last = conversation.slice(-12);
	return last
		.map((m) => {
			const who =
				m?.messageBy?.customerEmail === "management@xhotelpro.com"
					? "Agent"
					: "Guest";
			return `${who}: ${String(m.message || "").slice(0, 260)}`;
		})
		.join("\n");
}

async function planNext({ st, sc, hotel, conversation, userText }) {
	const lang = st.languageLabel || sc.preferredLanguage || "English";
	const intentHint = st.ctx?.intent || "other";
	const slots = st.ctx || {};
	const examples = sampleDisplayNames(hotel).join(" / ");
	const bullets = convoToBullets(conversation);

	const messages = [
		{
			role: "system",
			content:
				"You are a hotel booking assistant. Be warm, concise, and human-like. Ask ONLY one question per turn." +
				"\n— If intent is new reservation, strict order: dates → room type → price/availability → confirm proceed → name confirm → nationality → phone → email → final summary." +
				"\n— Accept HIJRI dates and convert to GREGORIAN internally. If dates are past/unclear, ask for a future range in one polite line." +
				"\n— If guest asks for room types, list 3–5 examples from provided hotel data, then ask them to choose." +
				"\n— If intent is known, NEVER ask 'How may I help?'. " +
				"\n— Handle smalltalk briefly and positively, then pivot back to the next needed step." +
				"\n— Avoid repetition; paraphrase if re‑asking. Do not mention you're an AI.",
		},
		{
			role: "user",
			content: `Language: ${lang}
Known intent: ${intentHint}
Awaiting: ${st.awaiting || "(none)"}
Hotel name: ${hotel?.hotelName || "Hotel"}
Room examples: ${examples || "(none provided)"}

Current slots:
${JSON.stringify(
	{
		checkinISO: slots.checkinISO,
		checkoutISO: slots.checkoutISO,
		nights: slots.nights,
		roomType: slots.roomType,
		displayName: slots.displayName,
		adults: slots.adults,
		children: slots.children,
		customerName: slots.customerName,
		nationality: slots.nationality,
		phone: slots.phone,
		email: slots.email,
	},
	null,
	2
)}

Recent conversation:
${bullets || "(empty)"}

Latest user text: "${userText || ""}"

Return ONLY JSON:
{
  "next_action": "ask_dates"|"answer_room_types"|"ask_room_type"|"quote"|"ask_confirm_proceed"|"ask_name_confirm"|"ask_name_value"|"ask_nationality"|"ask_phone"|"ask_email"|"final_summary"|"create_reservation"|"clarify"|"smalltalk_ack_and_ask_next",
  "response": "your reply (one clear question at the end)",
  "ctx_patch": { "roomType": "...", "checkinISO":"YYYY-MM-DD", "checkoutISO":"YYYY-MM-DD", "customerName":"...", "nationality":"...", "phone":"...", "email":"..." }
}`,
		},
	];

	const plan = await chatJSON({ messages, temperature: 0.25, max_tokens: 650 });
	return plan;
}

module.exports = { planNext, sampleDisplayNames };
