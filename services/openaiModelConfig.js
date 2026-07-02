const DEFAULT_OPENAI_MODEL = "gpt-5.4-mini";
const DEFAULT_OPENAI_FAST_MODEL = "gpt-5.4-mini";

const KIND_DEFAULT_MODELS = {
	analysis: DEFAULT_OPENAI_FAST_MODEL,
	reasoning: DEFAULT_OPENAI_MODEL,
	nlu: DEFAULT_OPENAI_FAST_MODEL,
	writer: DEFAULT_OPENAI_MODEL,
	default: DEFAULT_OPENAI_MODEL,
};

const DEFAULT_REASONING_EFFORTS = {
	analysis: "low",
	reasoning: "low",
	nlu: "low",
	writer: "low",
	default: "low",
};

const KIND_ENV_KEYS = {
	analysis: [
		"OPENAI_CHATBOT_ANALYSIS_MODEL",
		"AI_ANALYSIS_MODEL",
		"OPENAI_FAST_MODEL",
		"OPENAI_REASONING_MODEL",
		"OPENAI_MODEL",
		"AI_MODEL",
	],
	reasoning: [
		"OPENAI_CHATBOT_REASONING_MODEL",
		"OPENAI_REASONING_MODEL",
		"OPENAI_MODEL_NLU",
		"OPENAI_MODEL",
		"AI_MODEL",
	],
	nlu: [
		"OPENAI_CHATBOT_NLU_MODEL",
		"OPENAI_MODEL_NLU",
		"OPENAI_FAST_MODEL",
		"OPENAI_REASONING_MODEL",
		"OPENAI_MODEL",
		"AI_MODEL",
	],
	writer: [
		"OPENAI_CHATBOT_WRITER_MODEL",
		"OPENAI_CHATBOT_MODEL",
		"OPENAI_MODEL_WRITER",
		"OPENAI_MODEL",
		"AI_MODEL",
		"OPENAI_REASONING_MODEL",
	],
	default: [
		"OPENAI_CHATBOT_MODEL",
		"OPENAI_MODEL",
		"AI_MODEL",
		"OPENAI_REASONING_MODEL",
		"OPENAI_MODEL_NLU",
	],
};

const KIND_REASONING_ENV_KEYS = {
	analysis: [
		"OPENAI_CHATBOT_ANALYSIS_REASONING_EFFORT",
		"OPENAI_CHATBOT_REASONING_EFFORT",
		"OPENAI_REASONING_EFFORT",
	],
	reasoning: [
		"OPENAI_CHATBOT_BOOKING_REASONING_EFFORT",
		"OPENAI_CHATBOT_PLANNER_REASONING_EFFORT",
		"OPENAI_CHATBOT_REASONING_EFFORT",
		"OPENAI_REASONING_EFFORT",
	],
	nlu: ["OPENAI_CHATBOT_NLU_REASONING_EFFORT"],
	writer: [
		"OPENAI_CHATBOT_WRITER_REASONING_EFFORT",
		"OPENAI_CHATBOT_REPLY_REASONING_EFFORT",
		"OPENAI_CHATBOT_POLISH_REASONING_EFFORT",
	],
	default: ["OPENAI_CHATBOT_REASONING_EFFORT", "OPENAI_REASONING_EFFORT"],
};

function sanitizeModelName(value) {
	if (!value) return "";
	return String(value).split("#")[0].trim().split(/\s+/)[0] || "";
}

function pickOpenAIModel(kind = "default") {
	const envKeys = KIND_ENV_KEYS[kind] || KIND_ENV_KEYS.default;
	for (const key of envKeys) {
		const model = sanitizeModelName(process.env[key]);
		if (model) return model;
	}
	return (
		sanitizeModelName(process.env.OPENAI_DEFAULT_MODEL) ||
		KIND_DEFAULT_MODELS[kind] ||
		DEFAULT_OPENAI_MODEL
	);
}

function sanitizeReasoningEffort(value) {
	const effort = String(value || "").trim().toLowerCase();
	return [
		"none",
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
	].includes(effort)
		? effort
		: "";
}

function pickReasoningEffort(kind = "default") {
	const envKeys = KIND_REASONING_ENV_KEYS[kind] || KIND_REASONING_ENV_KEYS.default;
	for (const key of envKeys) {
		const effort = sanitizeReasoningEffort(process.env[key]);
		if (effort) return effort;
	}
	return DEFAULT_REASONING_EFFORTS[kind] || DEFAULT_REASONING_EFFORTS.default;
}

function usesCompletionTokens(model = "") {
	return /^(gpt-5|o\d|o-|chat-latest$)/i.test(String(model || ""));
}

function buildChatCompletionBody({
	model,
	messages,
	temperature,
	maxTokens,
	response_format,
	...rest
}) {
	const resolvedModel = sanitizeModelName(model) || pickOpenAIModel();
	const gpt5Style = usesCompletionTokens(resolvedModel);
	const tokenLimit = Number(maxTokens);
	const allowedReasoningEffort = sanitizeReasoningEffort(rest.reasoning_effort);
	delete rest.reasoning_effort;
	return {
		model: resolvedModel,
		messages,
		...rest,
		...(response_format ? { response_format } : {}),
		...(gpt5Style && allowedReasoningEffort
			? { reasoning_effort: allowedReasoningEffort }
			: {}),
		...(gpt5Style || temperature === undefined ? {} : { temperature }),
		...(Number.isFinite(tokenLimit) && tokenLimit > 0
			? gpt5Style
				? { max_completion_tokens: tokenLimit }
				: { max_tokens: tokenLimit }
			: {}),
	};
}

module.exports = {
	DEFAULT_OPENAI_MODEL,
	DEFAULT_OPENAI_FAST_MODEL,
	pickOpenAIModel,
	pickReasoningEffort,
	sanitizeModelName,
	sanitizeReasoningEffort,
	usesCompletionTokens,
	buildChatCompletionBody,
};
