// aiagent/core/openai.js
const OpenAI = require("openai");

function intFromEnv(name, fallback) {
	const value = parseInt(process.env[name] || "", 10);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

const OPENAI_TIMEOUT_MS = intFromEnv("OPENAI_TIMEOUT_MS", 45000);
const OPENAI_MAX_RETRIES = intFromEnv("OPENAI_MAX_RETRIES", 1);

const client = new OpenAI({
	apiKey: process.env.OPENAI_API_KEY,
	timeout: OPENAI_TIMEOUT_MS,
	maxRetries: OPENAI_MAX_RETRIES,
});

function pickModel(kind = "nlu") {
	// small ops -> mini; responses -> 4o
	if (kind === "nlu") return process.env.OPENAI_MODEL_NLU || "gpt-4o-mini";
	if (kind === "writer") return process.env.OPENAI_MODEL || "gpt-4o";
	return process.env.OPENAI_MODEL || "gpt-4o";
}

async function chat(
	messages,
	{ kind = "nlu", temperature = 0, max_tokens = 350 } = {}
) {
	const model = pickModel(kind);
	const usesCompletionTokens = /^(gpt-5|o\d|o-)/i.test(model);
	const tokenLimit = usesCompletionTokens
		? Math.max(max_tokens * 3, kind === "writer" ? 900 : 600)
		: max_tokens;
	const res = await client.chat.completions.create(
		{
			model,
			messages,
			...(usesCompletionTokens ? {} : { temperature }),
			...(usesCompletionTokens
				? { max_completion_tokens: tokenLimit }
				: { max_tokens: tokenLimit }),
		},
		{ timeout: OPENAI_TIMEOUT_MS, maxRetries: OPENAI_MAX_RETRIES }
	);
	return res.choices?.[0]?.message?.content?.trim() || "";
}

module.exports = { chat };
