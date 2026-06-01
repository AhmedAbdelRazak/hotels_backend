const OpenAI = require("openai");
const {
	buildChatCompletionBody,
	pickOpenAIModel,
} = require("./openaiModelConfig");

const ARABIC_RE = /[\u0600-\u06FF]/;

const compactText = (value = "", limit = 2000) =>
	String(value || "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, limit);

const inferBedsCountFromText = (...values) => {
	const text = compactText(values.filter(Boolean).join(" "), 1400);
	const match = text.match(
		/(\d{1,2})\s*(?:beds?|single beds?|bunks?|سرير|أسرة|اسرة)/i
	);
	if (!match) return 1;
	const parsed = Number(match[1]);
	return Number.isFinite(parsed) ? Math.max(1, Math.min(parsed, 20)) : 1;
};

const safeJsonParse = (value = "") => {
	try {
		return JSON.parse(value);
	} catch (_err) {
		const match = String(value || "").match(/\{[\s\S]*\}/);
		if (!match) return null;
		try {
			return JSON.parse(match[0]);
		} catch (_inner) {
			return null;
		}
	}
};

const fallbackRoomText = ({ name = "", description = "" } = {}) => {
	const cleanName = compactText(name, 180);
	const cleanDescription = compactText(description, 1200);
	const nameIsArabic = ARABIC_RE.test(cleanName);
	const descriptionIsArabic = ARABIC_RE.test(cleanDescription);
	return {
		displayName: nameIsArabic ? cleanName : cleanName,
		displayName_OtherLanguage: nameIsArabic ? cleanName : cleanName,
		description: descriptionIsArabic ? cleanDescription : cleanDescription,
		description_OtherLanguage: descriptionIsArabic
			? cleanDescription
			: cleanDescription,
		bedsCount: inferBedsCountFromText(cleanName, cleanDescription),
		aiApplied: false,
		aiModel: "",
	};
};

const normalizeAiRoomText = (parsed = {}, fallback = {}) => {
	const next = {
		displayName: compactText(parsed.displayNameEnglish, 180),
		displayName_OtherLanguage: compactText(parsed.displayNameArabic, 180),
		description: compactText(parsed.descriptionEnglish, 1200),
		description_OtherLanguage: compactText(parsed.descriptionArabic, 1200),
		bedsCount: Number(parsed.bedsCount),
	};

	const fallbackText = fallbackRoomText(fallback);
	if (!next.displayName) next.displayName = fallbackText.displayName;
	if (!next.displayName_OtherLanguage) {
		next.displayName_OtherLanguage = fallbackText.displayName_OtherLanguage;
	}
	if (!next.description) next.description = fallbackText.description;
	if (!next.description_OtherLanguage) {
		next.description_OtherLanguage = fallbackText.description_OtherLanguage;
	}
	if (!Number.isFinite(next.bedsCount) || next.bedsCount < 1) {
		next.bedsCount = fallbackText.bedsCount;
	}
	next.bedsCount = Math.max(1, Math.min(Math.floor(next.bedsCount), 20));

	return next;
};

const orchestrateRoomText = async ({
	name = "",
	description = "",
	roomType = "",
	language = "English",
} = {}) => {
	const cleanName = compactText(name, 180);
	const cleanDescription = compactText(description, 1200);
	if (!cleanName) {
		return {
			...fallbackRoomText({ name: cleanName, description: cleanDescription }),
			aiSkippedReason: "room_name_required",
		};
	}

	const apiKey = process.env.OPENAI_API_KEY || process.env.CHATGPT_API_TOKEN || "";
	if (!apiKey || !/^sk-/.test(String(apiKey).trim())) {
		return {
			...fallbackRoomText({ name: cleanName, description: cleanDescription }),
			aiSkippedReason: "openai_not_configured",
		};
	}

	const model = pickOpenAIModel("writer");
	const client = new OpenAI({ apiKey });
	const prompt = [
		"You are a professional bilingual hotel PMS copy editor.",
		"The platform supports only English and Arabic.",
		"Given one room name and one room description, produce polished English and polished Arabic.",
		"Keep the room name concise and hotel-appropriate. Do not invent amenities, prices, or policies.",
		"If the text clearly says how many beds are in each room, infer bedsCount as a number. Otherwise use 1.",
		"Return JSON only with keys: displayNameEnglish, displayNameArabic, descriptionEnglish, descriptionArabic, bedsCount.",
	].join(" ");

	try {
		const response = await client.chat.completions.create(
			buildChatCompletionBody({
				model,
				temperature: 0.2,
				maxTokens: 700,
				response_format: { type: "json_object" },
				messages: [
					{ role: "system", content: prompt },
					{
						role: "user",
						content: JSON.stringify({
							roomType,
							sourceLanguage: language,
							name: cleanName,
							description: cleanDescription,
						}),
					},
				],
			})
		);
		const content = response?.choices?.[0]?.message?.content || "";
		const parsed = safeJsonParse(content);
		if (!parsed) throw new Error("AI response was not JSON.");
		return {
			...normalizeAiRoomText(parsed, {
				name: cleanName,
				description: cleanDescription,
			}),
			aiApplied: true,
			aiModel: model,
		};
	} catch (error) {
		return {
			...fallbackRoomText({ name: cleanName, description: cleanDescription }),
			aiApplied: false,
			aiModel: model,
			aiSkippedReason: "openai_failed",
			aiError: error?.message || "AI text orchestration failed",
		};
	}
};

module.exports = {
	orchestrateRoomText,
};
