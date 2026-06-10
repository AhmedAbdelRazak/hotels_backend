// aiagent/core/openai.js
const OpenAI = require("openai");
const {
	buildChatCompletionBody,
	pickOpenAIModel,
	usesCompletionTokens,
} = require("../../services/openaiModelConfig");

function intFromEnv(name, fallback) {
	const value = parseInt(process.env[name] || "", 10);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

const OPENAI_TIMEOUT_MS = intFromEnv(
	"OPENAI_CHATBOT_TIMEOUT_MS",
	intFromEnv("OPENAI_TIMEOUT_MS", 6000)
);
const OPENAI_MAX_RETRIES = intFromEnv("OPENAI_MAX_RETRIES", 0);

const client = process.env.OPENAI_API_KEY
	? new OpenAI({
			apiKey: process.env.OPENAI_API_KEY,
			timeout: OPENAI_TIMEOUT_MS,
			maxRetries: OPENAI_MAX_RETRIES,
	  })
	: null;

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
	return pickOpenAIModel(kind);
}

function pickReasoningEffort() {
	return String(
		process.env.OPENAI_CHATBOT_REASONING_EFFORT ||
			process.env.OPENAI_REASONING_EFFORT ||
			"medium"
	)
		.trim()
		.toLowerCase();
}

async function chat(
	messages,
	{ kind = "nlu", temperature = 0, max_tokens = 350, reasoning_effort = "" } = {}
) {
	if (!client) {
		throw new Error("OPENAI_API_KEY is not configured.");
	}
	const model = pickModel(kind);
	const gpt5Style = usesCompletionTokens(model);
	const tokenLimit = gpt5Style
		? Math.max(max_tokens * 3, kind === "writer" ? 900 : 600)
		: max_tokens;
	const body = buildChatCompletionBody({
		model,
		messages,
		temperature,
		maxTokens: tokenLimit,
		reasoning_effort: gpt5Style ? reasoning_effort || pickReasoningEffort() : "",
	});
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
