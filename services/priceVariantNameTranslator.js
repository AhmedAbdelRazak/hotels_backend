/** @format */

"use strict";

const OpenAI = require("openai");
const {
	buildChatCompletionBody,
	pickOpenAIModel,
} = require("./openaiModelConfig");

const ARABIC_RE = /[\u0600-\u06FF]/;

const compactName = (value = "") =>
	String(value || "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 140);

const safeJsonParse = (value = "") => {
	try {
		return JSON.parse(value);
	} catch (_error) {
		const match = String(value || "").match(/\{[\s\S]*\}/);
		if (!match) return null;
		try {
			return JSON.parse(match[0]);
		} catch (_inner) {
			return null;
		}
	}
};

const fallbackNamePair = ({ name = "", nameOtherLanguage = "" } = {}) => {
	const cleanName = compactName(name);
	const cleanOther = compactName(nameOtherLanguage);
	const source = cleanName || cleanOther;
	if (!source) {
		return { name: "", nameOtherLanguage: "", aiApplied: false, aiModel: "" };
	}
	const sourceIsArabic = ARABIC_RE.test(source);
	return {
		name: sourceIsArabic ? cleanOther || source : cleanName || source,
		nameOtherLanguage: sourceIsArabic ? cleanName || source : cleanOther || source,
		aiApplied: false,
		aiModel: "",
	};
};

const normalizeNamePair = (parsed = {}, fallback = {}) => {
	const fallbackPair = fallbackNamePair(fallback);
	return {
		name:
			compactName(
				parsed.nameEnglish ||
					parsed.english ||
					parsed.name ||
					fallbackPair.name
			) || fallbackPair.name,
		nameOtherLanguage:
			compactName(
				parsed.nameArabic ||
					parsed.arabic ||
					parsed.nameOtherLanguage ||
					fallbackPair.nameOtherLanguage
			) || fallbackPair.nameOtherLanguage,
	};
};

const translatePriceVariantName = async ({
	name = "",
	nameOtherLanguage = "",
} = {}) => {
	const cleanName = compactName(name);
	const cleanOther = compactName(nameOtherLanguage);
	if (!cleanName && !cleanOther) return fallbackNamePair({ name, nameOtherLanguage });

	const apiKey = String(
		process.env.OPENAI_API_KEY || process.env.CHATGPT_API_TOKEN || ""
	).trim();
	if (!apiKey || !/^sk-/.test(apiKey)) {
		return {
			...fallbackNamePair({ name: cleanName, nameOtherLanguage: cleanOther }),
			aiSkippedReason: "openai_not_configured",
		};
	}

	const timeout = Math.max(
		3000,
		Number(process.env.PRICE_VARIANT_NAME_TRANSLATION_TIMEOUT_MS || 12000)
	);
	const client = new OpenAI({ apiKey, timeout, maxRetries: 0 });
	const model = pickOpenAIModel("writer");
	try {
		const response = await client.chat.completions.create(
			buildChatCompletionBody({
				model,
				temperature: 0.1,
				maxTokens: 220,
				response_format: { type: "json_object" },
				messages: [
					{
						role: "system",
						content: [
							"You translate short hotel pricing category names between English and Arabic.",
							"Return JSON only with keys nameEnglish and nameArabic.",
							"Keep names concise and natural for a hotel PMS.",
							"Do not add explanations, punctuation, prices, or extra details.",
							"Preserve numbers such as Price 1, Price 2, VIP, Agent, Website, Owner.",
						].join(" "),
					},
					{
						role: "user",
						content: JSON.stringify({
							name: cleanName,
							nameOtherLanguage: cleanOther,
						}),
					},
				],
			})
		);
		const parsed = safeJsonParse(response?.choices?.[0]?.message?.content || "");
		if (!parsed) throw new Error("AI response was not JSON.");
		return {
			...normalizeNamePair(parsed, {
				name: cleanName,
				nameOtherLanguage: cleanOther,
			}),
			aiApplied: true,
			aiModel: model,
		};
	} catch (error) {
		return {
			...fallbackNamePair({ name: cleanName, nameOtherLanguage: cleanOther }),
			aiApplied: false,
			aiModel: model,
			aiSkippedReason: "openai_failed",
			aiError: error?.message || "Pricing name translation failed",
		};
	}
};

module.exports = {
	translatePriceVariantName,
};
