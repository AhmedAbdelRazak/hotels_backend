// aiagent/core/openai.js
const OpenAI = require("openai");

function intFromEnv(name, fallback) {
	const value = parseInt(process.env[name] || "", 10);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

const OPENAI_TIMEOUT_MS = intFromEnv("OPENAI_TIMEOUT_MS", 20000);
const OPENAI_MAX_RETRIES = intFromEnv("OPENAI_MAX_RETRIES", 0);

const client = new OpenAI({
	apiKey: process.env.OPENAI_API_KEY,
	timeout: OPENAI_TIMEOUT_MS,
	maxRetries: OPENAI_MAX_RETRIES,
});

async function withDeadline(factory, timeoutMs) {
	const controller = new AbortController();
	let timer = null;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => {
			controller.abort();
			reject(new Error(`OpenAI request timed out after ${timeoutMs}ms`));
		}, timeoutMs);
	});
	try {
		return await Promise.race([factory(controller.signal), timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

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
	const body = {
		model,
		messages,
		...(usesCompletionTokens ? {} : { temperature }),
		...(usesCompletionTokens
			? { max_completion_tokens: tokenLimit }
			: { max_tokens: tokenLimit }),
	};
	const res = await withDeadline(
		(signal) =>
			client.chat.completions.create(body, {
				timeout: OPENAI_TIMEOUT_MS,
				maxRetries: OPENAI_MAX_RETRIES,
				signal,
			}),
		OPENAI_TIMEOUT_MS
	);
	return res.choices?.[0]?.message?.content?.trim() || "";
}

module.exports = { chat };
