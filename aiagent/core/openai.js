// aiagent/core/openai.js
const crypto = require("crypto");
const OpenAI = require("openai");
const {
	buildChatCompletionBody,
	pickChatbotOpenAIModel,
	pickChatbotReasoningEffort,
	sanitizeModelName,
	sanitizeReasoningEffort,
	usesCompletionTokens,
} = require("../../services/openaiModelConfig");
const { getReadyHotelOpenAiKnowledge } = require("./db");

function intFromEnv(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
	const value = parseInt(process.env[name] || "", 10);
	const resolved = Number.isFinite(value) && value >= min ? value : fallback;
	return Math.min(max, Math.max(min, resolved));
}

function boolFromEnv(name, fallback = false) {
	const raw = String(process.env[name] ?? "").trim().toLowerCase();
	if (!raw) return Boolean(fallback);
	return ["1", "true", "yes", "on", "enabled"].includes(raw);
}

const OPENAI_TIMEOUT_MS = intFromEnv(
	"OPENAI_CHATBOT_TIMEOUT_MS",
	intFromEnv("OPENAI_TIMEOUT_MS", 30000, { min: 1500, max: 60000 }),
	{ min: 1500, max: 60000 }
);
const OPENAI_MAX_RETRIES = intFromEnv(
	"OPENAI_CHATBOT_MAX_RETRIES",
	intFromEnv("OPENAI_MAX_RETRIES", 0, { min: 0, max: 3 }),
	{ min: 0, max: 3 }
);
const OPENAI_MAX_PROMPT_CHARS = intFromEnv(
	"OPENAI_CHATBOT_MAX_PROMPT_CHARS",
	28000
);
const OPENAI_RESPONSES_ENABLED = boolFromEnv(
	"OPENAI_CHATBOT_RESPONSES_ENABLED",
	true
);
const OPENAI_FILE_SEARCH_ENABLED = boolFromEnv(
	"OPENAI_CHATBOT_FILE_SEARCH_ENABLED",
	true
);
const OPENAI_FILE_SEARCH_MAX_RESULTS = intFromEnv(
	"OPENAI_CHATBOT_FILE_SEARCH_MAX_RESULTS",
	3,
	{ min: 1, max: 50 }
);
const OPENAI_OUTPUT_TOKEN_MULTIPLIER = intFromEnv(
	"OPENAI_CHATBOT_OUTPUT_TOKEN_MULTIPLIER",
	6,
	{ min: 3, max: 12 }
);
const OPENAI_MAX_OUTPUT_TOKENS = intFromEnv(
	"OPENAI_CHATBOT_MAX_OUTPUT_TOKENS",
	12000,
	{ min: 2000, max: 32000 }
);
const OPENAI_REASONING_MIN_OUTPUT_TOKENS = intFromEnv(
	"OPENAI_CHATBOT_REASONING_MIN_OUTPUT_TOKENS",
	4000,
	{ min: 1000, max: OPENAI_MAX_OUTPUT_TOKENS }
);
const OPENAI_WRITER_MIN_OUTPUT_TOKENS = intFromEnv(
	"OPENAI_CHATBOT_WRITER_MIN_OUTPUT_TOKENS",
	1800,
	{ min: 600, max: OPENAI_MAX_OUTPUT_TOKENS }
);
const OPENAI_SUPPORT_MIN_OUTPUT_TOKENS = intFromEnv(
	"OPENAI_CHATBOT_SUPPORT_MIN_OUTPUT_TOKENS",
	1200,
	{ min: 450, max: OPENAI_MAX_OUTPUT_TOKENS }
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
	return pickChatbotOpenAIModel(kind);
}

function minimumOutputTokensForKind(kind = "nlu") {
	if (["reasoning", "default"].includes(kind)) {
		return OPENAI_REASONING_MIN_OUTPUT_TOKENS;
	}
	if (kind === "writer") return OPENAI_WRITER_MIN_OUTPUT_TOKENS;
	return OPENAI_SUPPORT_MIN_OUTPUT_TOKENS;
}

function initialOutputTokenLimit(kind = "nlu", requestedTokens = 0, model = "") {
	const requested = Math.max(1, Number(requestedTokens || 0) || 1);
	if (!usesCompletionTokens(model)) return requested;
	return Math.min(
		OPENAI_MAX_OUTPUT_TOKENS,
		Math.max(
			minimumOutputTokensForKind(kind),
			requested * OPENAI_OUTPUT_TOKEN_MULTIPLIER
		)
	);
}

function fileSearchToolForVectorStore(
	vectorStoreId = "",
	maxResults = OPENAI_FILE_SEARCH_MAX_RESULTS
) {
	const id = String(vectorStoreId || "").trim();
	if (!/^vs_[A-Za-z0-9_-]+$/.test(id)) return null;
	const resultLimit = Math.max(1, Math.min(Number(maxResults) || 3, 50));
	return {
		type: "file_search",
		vector_store_ids: [id],
		max_num_results: resultLimit,
	};
}

function responseUsedFileSearch(response = {}) {
	return (Array.isArray(response?.output) ? response.output : []).some(
		(item) => item?.type === "file_search_call"
	);
}

function responsesThreadContextKey({
	model = "",
	vectorStoreId = "",
	factPackHash = "",
} = {}) {
	return crypto
		.createHash("sha256")
		.update(
			JSON.stringify({
				model: sanitizeModelName(model),
				vectorStoreId: String(vectorStoreId || "").trim(),
				factPackHash: String(factPackHash || "").trim(),
			})
		)
		.digest("hex");
}

function resolveResponsesThreadContinuation({
	previousResponseId = "",
	previousContextKey = "",
	currentContextKey = "",
	resetThread = false,
} = {}) {
	const responseId = String(previousResponseId || "").trim();
	const priorKey = String(previousContextKey || "").trim();
	const currentKey = String(currentContextKey || "").trim();
	const contextChanged = Boolean(priorKey && currentKey && priorKey !== currentKey);
	const reset = Boolean(responseId && (resetThread || contextChanged));
	return {
		previousResponseId: reset ? "" : responseId,
		threadReset: reset,
		contextChanged,
	};
}

async function resolveCurrentHotelFileSearchContext(metadata = {}) {
	if (!OPENAI_FILE_SEARCH_ENABLED) return null;
	const hotelId = String(metadata?.hotelId || "").trim();
	if (!hotelId) return null;
	try {
		const knowledge = await getReadyHotelOpenAiKnowledge(hotelId);
		if (!knowledge || knowledge.hotelId !== hotelId) return null;
		return knowledge;
	} catch (error) {
		console.warn(
			"[aiagent] hotel file-search context unavailable:",
			error?.message || error
		);
		return null;
	}
}

function getChatbotOpenAIRuntimeConfig() {
	return {
		responsesEnabled: OPENAI_RESPONSES_ENABLED,
		responseContinuationEnabled: boolFromEnv(
			"AI_OPENAI_RESPONSE_CONTINUATION",
			false
		),
		timeoutMs: OPENAI_TIMEOUT_MS,
		maxRetries: OPENAI_MAX_RETRIES,
		fileSearch: {
			enabled: OPENAI_FILE_SEARCH_ENABLED && OPENAI_RESPONSES_ENABLED,
			api: "responses",
			currentHotelOnly: true,
			readyKnowledgeOnly: true,
			maxResults: OPENAI_FILE_SEARCH_MAX_RESULTS,
		},
		outputTokens: {
			multiplier: OPENAI_OUTPUT_TOKEN_MULTIPLIER,
			maximum: OPENAI_MAX_OUTPUT_TOKENS,
			reasoningMinimum: OPENAI_REASONING_MIN_OUTPUT_TOKENS,
			writerMinimum: OPENAI_WRITER_MIN_OUTPUT_TOKENS,
			supportMinimum: OPENAI_SUPPORT_MIN_OUTPUT_TOKENS,
		},
	};
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

function incompleteResponseReason(res = {}) {
	return (
		String(res?.incomplete_details?.reason || "").trim() ||
		(res?.status === "incomplete" ? "incomplete" : "")
	);
}

function isIncompleteResponse(res = {}) {
	return res?.status === "incomplete" || Boolean(incompleteResponseReason(res));
}

class OpenAIIncompleteResponseError extends Error {
	constructor(res = {}, previousResponseId = "", model = "", maxOutputTokens = 0) {
		const reason = incompleteResponseReason(res) || "incomplete";
		super(`OpenAI response incomplete: ${reason}`);
		this.name = "OpenAIIncompleteResponseError";
		this.code = "openai_response_incomplete";
		this.incomplete = true;
		this.reason = reason;
		this.responseId = res?.id || "";
		this.previousResponseId = previousResponseId || "";
		this.model = model || "";
		this.maxOutputTokens = Number(maxOutputTokens || 0) || 0;
		this.partialTextLength = extractResponseText(res).length;
		this.usage = res?.usage || null;
	}
}

function isIncompleteOpenAIError(error = {}) {
	return error?.incomplete === true || error?.code === "openai_response_incomplete";
}

function expandedOutputTokenLimit(value = 0) {
	const base = Number(value || 0) || 0;
	if (!base) return 0;
	return Math.min(
		OPENAI_MAX_OUTPUT_TOKENS,
		Math.max(base + 2500, base * 3)
	);
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
	file_search_vector_store_id = "",
	file_search_max_results = OPENAI_FILE_SEARCH_MAX_RESULTS,
}) {
	const resolvedModel = sanitizeModelName(model) || pickModel("default");
	const gpt5Style = usesCompletionTokens(resolvedModel);
	const tokenLimit = Number(maxTokens);
	const allowedReasoningEffort = sanitizeReasoningEffort(reasoning_effort);
	const { instructions, input } = splitMessagesForResponses(messages, response_format);
	const text = responseTextConfig(response_format);
	const fileSearchTool = fileSearchToolForVectorStore(
		file_search_vector_store_id,
		file_search_max_results
	);
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
		...(fileSearchTool ? { tools: [fileSearchTool] } : {}),
		...(gpt5Style && allowedReasoningEffort
			? { reasoning: { effort: allowedReasoningEffort } }
			: {}),
		...(gpt5Style || temperature === undefined ? {} : { temperature }),
		...(Number.isFinite(tokenLimit) && tokenLimit > 0
			? { max_output_tokens: tokenLimit }
			: {}),
	};
}

async function runChatCompletion(
	messages,
	{
		kind = "nlu",
		temperature = 0,
		max_tokens = 350,
		reasoning_effort = "",
		response_format = null,
		max_output_tokens = 0,
	} = {}
) {
	if (!client) {
		throw new Error("OPENAI_API_KEY is not configured.");
	}
	const startedAt = Date.now();
	const model = pickModel(kind);
	const gpt5Style = usesCompletionTokens(model);
	const tokenLimit = Number(max_output_tokens) > 0
		? Math.min(OPENAI_MAX_OUTPUT_TOKENS, Number(max_output_tokens))
		: initialOutputTokenLimit(kind, max_tokens, model);
	const body = buildChatCompletionBody({
		model,
		messages: trimMessagesForOpenAI(
			ensureJsonTokenForResponseFormat(messages, response_format)
		),
		temperature,
		maxTokens: tokenLimit,
		response_format,
		reasoning_effort: gpt5Style
			? reasoning_effort || pickChatbotReasoningEffort(kind)
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
	const choice = res.choices?.[0] || {};
	const text = choice?.message?.content?.trim() || "";
	if (choice.finish_reason === "length") {
		const error = new Error("OpenAI chat completion incomplete: length");
		error.code = "openai_chat_completion_incomplete";
		error.incomplete = true;
		error.reason = "length";
		error.partialTextLength = text.length;
		error.model = res?.model || model;
		error.usage = res?.usage || null;
		throw error;
	}
	return {
		text,
		responseId: "",
		previousResponseId: "",
		api: "chat_completions",
		model: res?.model || model,
		latencyMs: Date.now() - startedAt,
		usage: res?.usage || null,
		fileSearchUsed: false,
		fileSearchConfigured: false,
	};
}

async function chat(messages, options = {}) {
	const result = await runChatCompletion(messages, options);
	return result.text;
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
		previous_response_context_key = "",
		reset_thread = false,
	} = {}
) {
	const overallStartedAt = Date.now();
	if (!client) {
		throw new Error("OPENAI_API_KEY is not configured.");
	}
	const finish = (result = {}) => ({
		...result,
		model: result.model || pickModel(kind),
		latencyMs: Date.now() - overallStartedAt,
		usage: result.usage || null,
		fileSearchUsed: Boolean(result.fileSearchUsed),
	});
	if (!use_responses || !client.responses?.create) {
		return finish(
			await runChatCompletion(messages, {
				kind,
				temperature,
				max_tokens,
				reasoning_effort,
				response_format,
			})
		);
	}
	const model = pickModel(kind);
	const gpt5Style = usesCompletionTokens(model);
	const tokenLimit = initialOutputTokenLimit(kind, max_tokens, model);
	const fileSearchContext = await resolveCurrentHotelFileSearchContext(metadata);
	const vectorStoreId = fileSearchContext?.vectorStoreId || "";
	const threadContextKey = responsesThreadContextKey({
		model,
		vectorStoreId,
		factPackHash: metadata?.factPackHash,
	});
	const continuation = resolveResponsesThreadContinuation({
		previousResponseId: previous_response_id,
		previousContextKey: previous_response_context_key,
		currentContextKey: threadContextKey,
		resetThread: reset_thread,
	});
	const effectivePreviousResponseId = continuation.previousResponseId;
	const buildBody = (previousResponseId = "", maxOutputTokens = tokenLimit) =>
		buildResponsesBody({
			model,
			messages,
			temperature,
			maxTokens: maxOutputTokens,
			response_format,
			reasoning_effort: gpt5Style
				? reasoning_effort || pickChatbotReasoningEffort(kind)
				: "",
			previous_response_id: previousResponseId,
			metadata,
			prompt_cache_key,
			safety_identifier,
			file_search_vector_store_id: vectorStoreId,
			file_search_max_results: OPENAI_FILE_SEARCH_MAX_RESULTS,
		});
	const runResponses = async (
		previousResponseId = "",
		maxOutputTokens = tokenLimit,
		threadReset = continuation.threadReset
	) => {
		const body = buildBody(previousResponseId, maxOutputTokens);
		const res = await withDeadline(
			(signal) =>
				client.responses.create(body, {
					timeout: OPENAI_TIMEOUT_MS,
					maxRetries: OPENAI_MAX_RETRIES,
					signal,
				}),
			OPENAI_TIMEOUT_MS
		);
		if (isIncompleteResponse(res)) {
			throw new OpenAIIncompleteResponseError(res, previousResponseId, model, maxOutputTokens);
		}
		return {
			text: extractResponseText(res),
			responseId: res.id || "",
			previousResponseId,
			api: "responses",
			model: res?.model || model,
			usage: res?.usage || null,
			fileSearchUsed: responseUsedFileSearch(res),
			fileSearchConfigured: Boolean(vectorStoreId),
			threadContextKey,
			threadReset: Boolean(threadReset),
			knowledgeVersion: fileSearchContext?.knowledgeVersion || 0,
		};
	};
	try {
		return finish(await runResponses(effectivePreviousResponseId));
	} catch (error) {
		if (isIncompleteOpenAIError(error)) {
			const retryTokenLimit = expandedOutputTokenLimit(error.maxOutputTokens || tokenLimit);
			if (retryTokenLimit && retryTokenLimit > tokenLimit) {
				console.warn("[aiagent] responses incomplete retry:", {
					reason: error.reason || error.message,
					partialTextLength: error.partialTextLength || 0,
					maxOutputTokens: error.maxOutputTokens || tokenLimit,
					retryMaxOutputTokens: retryTokenLimit,
					previousResponseId: effectivePreviousResponseId ? "present" : "",
				});
				try {
					return finish(
						await runResponses(effectivePreviousResponseId, retryTokenLimit)
					);
				} catch (retryError) {
					console.warn(
						"[aiagent] responses incomplete retry fallback:",
						retryError?.message || retryError
					);
				}
			}
		}
		if (effectivePreviousResponseId) {
			console.warn("[aiagent] responses continuation reset:", error?.message || error);
			try {
				return finish(
					await runResponses(
						"",
						expandedOutputTokenLimit(tokenLimit) || tokenLimit,
						true
					)
				);
			} catch (retryError) {
				console.warn("[aiagent] responses retry fallback:", retryError?.message || retryError);
			}
		} else {
			console.warn("[aiagent] responses fallback:", error?.message || error);
		}
		const fallback = await runChatCompletion(messages, {
				kind,
				temperature,
				max_tokens,
				max_output_tokens:
					expandedOutputTokenLimit(tokenLimit) || tokenLimit,
				reasoning_effort,
				response_format,
			});
		return finish({
			...fallback,
			previousResponseId: effectivePreviousResponseId,
			api: "chat_completions_fallback",
			fileSearchUsed: false,
			fileSearchConfigured: false,
			threadContextKey,
			threadReset: continuation.threadReset,
		});
	}
}

module.exports = {
	chat,
	chatWithState,
	pickReasoningEffort: pickChatbotReasoningEffort,
	buildResponsesBody,
	fileSearchToolForVectorStore,
	responseUsedFileSearch,
	responsesThreadContextKey,
	resolveResponsesThreadContinuation,
	trimMessagesForOpenAI,
	initialOutputTokenLimit,
	getChatbotOpenAIRuntimeConfig,
};
