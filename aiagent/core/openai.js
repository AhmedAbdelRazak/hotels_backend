// aiagent/core/openai.js
const OpenAI = require("openai");
const {
	buildChatCompletionBody,
	pickOpenAIModel,
	pickReasoningEffort,
	sanitizeModelName,
	sanitizeReasoningEffort,
	usesCompletionTokens,
} = require("../../services/openaiModelConfig");

function intFromEnv(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
	const value = parseInt(process.env[name] || "", 10);
	const resolved = Number.isFinite(value) && value > 0 ? value : fallback;
	return Math.min(max, Math.max(min, resolved));
}

function boolFromEnv(name, fallback = false) {
	const raw = String(process.env[name] ?? "").trim().toLowerCase();
	if (!raw) return Boolean(fallback);
	return ["1", "true", "yes", "on", "enabled"].includes(raw);
}

const OPENAI_TIMEOUT_MS = intFromEnv(
	"OPENAI_CHATBOT_TIMEOUT_MS",
	intFromEnv("OPENAI_TIMEOUT_MS", 20000, { min: 1500, max: 20000 }),
	{ min: 1500, max: 20000 }
);
const OPENAI_MAX_RETRIES = intFromEnv("OPENAI_MAX_RETRIES", 0);
const OPENAI_MAX_PROMPT_CHARS = intFromEnv(
	"OPENAI_CHATBOT_MAX_PROMPT_CHARS",
	28000
);
const OPENAI_RESPONSES_ENABLED = boolFromEnv(
	"OPENAI_CHATBOT_RESPONSES_ENABLED",
	true
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

function ensureJsonTokenForResponseFormat(messages = [], response_format = null) {
	if (!response_format || response_format.type !== "json_object") {
		return Array.isArray(messages) ? messages : [];
	}
	const input = Array.isArray(messages) ? messages : [];
	const hasLowercaseJson = input.some((message) =>
		/\bjson\b/.test(String(message?.content || ""))
	);
	if (hasLowercaseJson) return input;
	return [{ role: "system", content: "Return valid json only." }, ...input];
}

function splitMessagesForResponses(messages = [], response_format = null) {
	const trimmed = trimMessagesForOpenAI(
		ensureJsonTokenForResponseFormat(messages, response_format)
	);
	const instructions = trimmed
		.filter((message) => message?.role === "system" || message?.role === "developer")
		.map((message) => String(message?.content || "").trim())
		.filter(Boolean)
		.join("\n\n");
	const input = trimmed
		.filter((message) => message?.role !== "system" && message?.role !== "developer")
		.map((message) => ({
			role: message?.role === "assistant" ? "assistant" : "user",
			content: String(message?.content || ""),
		}))
		.filter((message) => message.content.trim());
	if (
		response_format &&
		["json_object", "json_schema"].includes(response_format.type) &&
		!input.some((message) => /\bjson\b/i.test(message.content))
	) {
		input.unshift({ role: "user", content: "Return valid JSON only." });
	}
	return { instructions, input };
}

function responseTextConfig(response_format = null) {
	if (!response_format) return null;
	if (response_format.type === "json_object") {
		return { format: { type: "json_object" } };
	}
	if (response_format.type === "json_schema") {
		const jsonSchema = response_format.json_schema || response_format.schema || {};
		return {
			format: {
				type: "json_schema",
				name: jsonSchema.name || response_format.name || "chatbot_response",
				schema: jsonSchema.schema || jsonSchema,
				strict: jsonSchema.strict ?? response_format.strict ?? true,
			},
		};
	}
	return null;
}

function extractResponseText(res = {}) {
	if (typeof res.output_text === "string" && res.output_text.trim()) {
		return res.output_text.trim();
	}
	const parts = [];
	for (const item of Array.isArray(res.output) ? res.output : []) {
		for (const content of Array.isArray(item?.content) ? item.content : []) {
			if (typeof content?.text === "string") parts.push(content.text);
			if (typeof content?.output_text === "string") parts.push(content.output_text);
		}
	}
	return parts.join("").trim();
}

function buildResponsesBody({
	model,
	messages,
	temperature,
	maxTokens,
	response_format,
	reasoning_effort = "",
	previous_response_id = "",
	metadata = {},
	prompt_cache_key = "",
	safety_identifier = "",
}) {
	const resolvedModel = sanitizeModelName(model) || pickOpenAIModel();
	const gpt5Style = usesCompletionTokens(resolvedModel);
	const tokenLimit = Number(maxTokens);
	const allowedReasoningEffort = sanitizeReasoningEffort(reasoning_effort);
	const { instructions, input } = splitMessagesForResponses(messages, response_format);
	const text = responseTextConfig(response_format);
	return {
		model: resolvedModel,
		instructions,
		input,
		store: true,
		...(previous_response_id ? { previous_response_id } : {}),
		...(text ? { text } : {}),
		...(metadata && Object.keys(metadata).length ? { metadata } : {}),
		...(prompt_cache_key ? { prompt_cache_key } : {}),
		...(safety_identifier ? { safety_identifier } : {}),
		...(gpt5Style && allowedReasoningEffort
			? { reasoning: { effort: allowedReasoningEffort } }
			: {}),
		...(gpt5Style || temperature === undefined ? {} : { temperature }),
		...(Number.isFinite(tokenLimit) && tokenLimit > 0
			? { max_output_tokens: tokenLimit }
			: {}),
	};
}

async function chat(
	messages,
	{
		kind = "nlu",
		temperature = 0,
		max_tokens = 350,
		reasoning_effort = "",
		response_format = null,
	} = {}
) {
	if (!client) {
		throw new Error("OPENAI_API_KEY is not configured.");
	}
	const model = pickModel(kind);
	const gpt5Style = usesCompletionTokens(model);
	const tokenLimit = gpt5Style
		? Math.max(max_tokens * 3, kind === "writer" ? 600 : 450)
		: max_tokens;
	const body = buildChatCompletionBody({
		model,
		messages: trimMessagesForOpenAI(
			ensureJsonTokenForResponseFormat(messages, response_format)
		),
		temperature,
		maxTokens: tokenLimit,
		response_format,
		reasoning_effort: gpt5Style
			? reasoning_effort || pickReasoningEffort(kind)
			: "",
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

async function chatWithState(
	messages,
	{
		kind = "nlu",
		temperature = 0,
		max_tokens = 350,
		reasoning_effort = "",
		response_format = null,
		previous_response_id = "",
		metadata = {},
		prompt_cache_key = "",
		safety_identifier = "",
		use_responses = OPENAI_RESPONSES_ENABLED,
	} = {}
) {
	if (!client) {
		throw new Error("OPENAI_API_KEY is not configured.");
	}
	if (!use_responses || !client.responses?.create) {
		return {
			text: await chat(messages, {
				kind,
				temperature,
				max_tokens,
				reasoning_effort,
				response_format,
			}),
			responseId: "",
			previousResponseId: "",
			api: "chat_completions",
		};
	}
	const model = pickModel(kind);
	const gpt5Style = usesCompletionTokens(model);
	const tokenLimit = gpt5Style
		? Math.max(max_tokens * 3, kind === "writer" ? 600 : 450)
		: max_tokens;
	const buildBody = (previousResponseId = "") =>
		buildResponsesBody({
			model,
			messages,
			temperature,
			maxTokens: tokenLimit,
			response_format,
			reasoning_effort: gpt5Style
				? reasoning_effort || pickReasoningEffort(kind)
				: "",
			previous_response_id: previousResponseId,
			metadata,
			prompt_cache_key,
			safety_identifier,
		});
	const runResponses = async (previousResponseId = "") => {
		const body = buildBody(previousResponseId);
		const res = await withDeadline(
			(signal) =>
				client.responses.create(body, {
					timeout: OPENAI_TIMEOUT_MS,
					maxRetries: OPENAI_MAX_RETRIES,
					signal,
				}),
			OPENAI_TIMEOUT_MS
		);
		return {
			text: extractResponseText(res),
			responseId: res.id || "",
			previousResponseId,
			api: "responses",
			model,
		};
	};
	try {
		return await runResponses(previous_response_id);
	} catch (error) {
		if (previous_response_id) {
			console.warn("[aiagent] responses continuation reset:", error?.message || error);
			try {
				return await runResponses("");
			} catch (retryError) {
				console.warn("[aiagent] responses retry fallback:", retryError?.message || retryError);
			}
		} else {
			console.warn("[aiagent] responses fallback:", error?.message || error);
		}
		return {
			text: await chat(messages, {
				kind,
				temperature,
				max_tokens,
				reasoning_effort,
				response_format,
			}),
			responseId: "",
			previousResponseId: previous_response_id || "",
			api: "chat_completions_fallback",
		};
	}
}

module.exports = { chat, chatWithState, pickReasoningEffort };
