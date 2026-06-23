// aiagent/core/openai.js
const OpenAI = require("openai");
const {
	buildChatCompletionBody,
	pickOpenAIModel,
	usesCompletionTokens,
} = require("../../services/openaiModelConfig");

function intFromEnv(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
	const value = parseInt(process.env[name] || "", 10);
	const resolved = Number.isFinite(value) && value > 0 ? value : fallback;
	return Math.min(max, Math.max(min, resolved));
}

const OPENAI_TIMEOUT_MS = intFromEnv(
	"OPENAI_CHATBOT_TIMEOUT_MS",
	intFromEnv("OPENAI_TIMEOUT_MS", 6000),
	{ min: 1500, max: 6000 }
);
const OPENAI_MAX_RETRIES = intFromEnv("OPENAI_MAX_RETRIES", 0);
const OPENAI_MAX_PROMPT_CHARS = intFromEnv(
	"OPENAI_CHATBOT_MAX_PROMPT_CHARS",
	28000
);

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
			"low"
	)
		.trim()
		.toLowerCase();
}

function clipMiddle(text = "", maxChars = 0) {
	const raw = String(text || "");
	const limit = Number(maxChars) || 0;
	if (!limit || raw.length <= limit) return raw;
	if (limit <= 200) return raw.slice(0, limit);
	const head = Math.floor(limit * 0.6);
	const tail = limit - head - 80;
	return `${raw.slice(0, head)}\n\n[...context trimmed for stability...]\n\n${raw.slice(
		Math.max(0, raw.length - tail)
	)}`;
}

function trimMessagesForOpenAI(messages = []) {
	const maxChars = Math.max(4000, OPENAI_MAX_PROMPT_CHARS);
	const input = Array.isArray(messages) ? messages : [];
	const total = input.reduce(
		(sum, message) => sum + String(message?.content || "").length,
		0
	);
	if (total <= maxChars) return input;

	const systemBudget = Math.floor(maxChars * 0.45);
	const otherBudget = Math.max(1200, maxChars - systemBudget);
	const systemMessages = input.filter((message) => message?.role === "system");
	const nonSystemMessages = input.filter((message) => message?.role !== "system");
	const systemCount = Math.max(1, systemMessages.length);
	const otherCount = Math.max(1, nonSystemMessages.length);

	return input.map((message) => {
		const isSystem = message?.role === "system";
		const budget = Math.floor(
			(isSystem ? systemBudget : otherBudget) /
				(isSystem ? systemCount : otherCount)
		);
		return {
			...message,
			content: clipMiddle(message?.content || "", budget),
		};
	});
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
		messages: trimMessagesForOpenAI(messages),
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
