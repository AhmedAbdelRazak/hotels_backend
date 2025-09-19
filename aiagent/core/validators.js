/** @format */
// aiagent/core/validators.js
const { chatJSON } = require("./openai");

// Simple Levenshtein for fuzzy prompts/suggestions
function levenshtein(a, b) {
	a = (a || "").toLowerCase();
	b = (b || "").toLowerCase();
	const m = Array.from({ length: a.length + 1 }, (_, i) =>
		[i].concat(Array(b.length).fill(0))
	);
	for (let j = 1; j <= b.length; j++) m[0][j] = j;
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			m[i][j] = Math.min(
				m[i - 1][j] + 1,
				m[i][j - 1] + 1,
				m[i - 1][j - 1] + cost
			);
		}
	}
	const dist = m[a.length][b.length];
	const maxLen = Math.max(a.length, b.length) || 1;
	return 1 - dist / maxLen; // similarity 0..1
}

function bestRoomTypeMatch(hotel, text) {
	if (!hotel) return null;
	const items = (hotel.roomCountDetails || []).map((r) => ({
		key: r.roomType,
		disp: String(r.displayName || r.roomType || "").toLowerCase(),
	}));
	const t = (text || "").toLowerCase();
	let best = null;
	for (const it of items) {
		const score = Math.max(
			levenshtein(t, it.disp),
			levenshtein(t, (it.key || "").toLowerCase())
		);
		if (!best || score > best.score) best = { ...it, score };
	}
	return best && best.score >= 0.66 ? best.key : null;
}

async function validateNationalityLLM(text, language = "English") {
	if (!text) return { valid: false, normalized: null };
	const messages = [
		{
			role: "system",
			content:
				"You validate nationalities/demonyms in ANY language. Return ONLY JSON with keys: valid(boolean), normalized(string|null), country(string|null). " +
				"If input is not a valid nationality/demonym, return valid=false, normalized=null, country=null.",
		},
		{
			role: "user",
			content: `Language hint: ${language}\nNationality/demonym text: """${text}"""\nReturn ONLY JSON.`,
		},
	];
	try {
		const out = await chatJSON({ messages, temperature: 0.0, max_tokens: 120 });
		if (out && typeof out.valid === "boolean") {
			return {
				valid: !!out.valid,
				normalized: out.normalized || null,
				country: out.country || null,
			};
		}
	} catch (_) {}
	return { valid: false, normalized: null, country: null };
}

module.exports = { levenshtein, bestRoomTypeMatch, validateNationalityLLM };
