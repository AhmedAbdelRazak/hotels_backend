/** @format */
let OpenAI = null;
try {
	OpenAI = require("openai");
} catch (_) {
	/* optional */
}

/**
 * If OPENAI_API_KEY exists, ask the LLM to clarify/extract fields from free text.
 * Returns {checkin, checkout, roomType, displayName, phone, email, nationality} or null.
 */
async function refineWithLLM({ text, state }) {
	if (!OpenAI || !process.env.OPENAI_API_KEY) return null;

	const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
	const rooms = (state.hotel?.roomCountDetails || []).map((r) => ({
		roomType: r.roomType,
		displayName: r.displayName || r.roomType,
	}));

	const sys = [
		"You are a multilingual reservation assistant for Umrah hotels (Makkah and Madinah).",
		"Extract structured fields from possibly misspelled user text.",
		"Allowed languages: English, Arabic (Fos7a/Egyptian), Spanish, French, Urdu, Hindi.",
		"Output STRICT JSON with keys: checkin, checkout, roomType, displayName, phone, email, nationality.",
		"Dates must be YYYY-MM-DD or null. Choose roomType ONLY from provided list if possible.",
	].join(" ");

	const user = JSON.stringify({
		text,
		languages: state.preferredLanguage,
		knownRooms: rooms,
		hints: {
			// add future hints if needed
		},
	});

	try {
		const res = await client.chat.completions.create({
			model: process.env.OPENAI_MODEL || "gpt-4o-mini",
			temperature: 0.2,
			response_format: { type: "json_object" },
			messages: [
				{ role: "system", content: sys },
				{ role: "user", content: user },
			],
		});
		const json = res?.choices?.[0]?.message?.content || "{}";
		const data = JSON.parse(json);
		return data && typeof data === "object" ? data : null;
	} catch (e) {
		console.error("[aiagent] LLM clarify error:", e?.message || e);
		return null;
	}
}

module.exports = { refineWithLLM };
