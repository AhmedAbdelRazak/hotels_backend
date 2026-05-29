const DEFAULT_OPENAI_MODEL = "gpt-5.5";

const KIND_ENV_KEYS = {
	analysis: [
		"AI_ANALYSIS_MODEL",
		"OPENAI_REASONING_MODEL",
		"OPENAI_MODEL",
		"AI_MODEL",
	],
	reasoning: [
		"OPENAI_REASONING_MODEL",
		"OPENAI_MODEL_NLU",
		"OPENAI_MODEL",
		"AI_MODEL",
	],
	nlu: [
		"OPENAI_MODEL_NLU",
		"OPENAI_REASONING_MODEL",
		"OPENAI_MODEL",
		"AI_MODEL",
	],
	writer: ["OPENAI_MODEL", "AI_MODEL", "OPENAI_REASONING_MODEL"],
	default: [
		"OPENAI_MODEL",
		"AI_MODEL",
		"OPENAI_REASONING_MODEL",
		"OPENAI_MODEL_NLU",
	],
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
	return sanitizeModelName(process.env.OPENAI_DEFAULT_MODEL) || DEFAULT_OPENAI_MODEL;
}

function usesCompletionTokens(model = "") {
	return /^(gpt-5|o\d|o-)/i.test(String(model || ""));
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
	return {
		model: resolvedModel,
		messages,
		...rest,
		...(response_format ? { response_format } : {}),
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
	pickOpenAIModel,
	sanitizeModelName,
	usesCompletionTokens,
	buildChatCompletionBody,
};
