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

const normalizeFeatureList = (items = []) =>
	Array.isArray(items)
		? items
				.map((item) => compactText(item, 90))
				.filter((item, index, list) => item && list.indexOf(item) === index)
				.slice(0, 8)
		: [];

const ARABIC_FEATURE_LABELS = {
	WiFi: "\u0648\u0627\u064a \u0641\u0627\u064a",
	TV: "\u062a\u0644\u0641\u0627\u0632",
	"Air Conditioning": "\u062a\u0643\u064a\u064a\u0641",
	"Mini Bar": "\u0645\u064a\u0646\u064a \u0628\u0627\u0631",
	Smoking: "\u064a\u0633\u0645\u062d \u0628\u0627\u0644\u062a\u062f\u062e\u064a\u0646",
	"Non-Smoking": "\u063a\u064a\u0631 \u0645\u0633\u0645\u0648\u062d \u0628\u0627\u0644\u062a\u062f\u062e\u064a\u0646",
	Pool: "\u0645\u0633\u0628\u062d",
	Gym: "\u0646\u0627\u062f\u064a \u0631\u064a\u0627\u0636\u064a",
	Restaurant: "\u0645\u0637\u0639\u0645",
	"Room Service": "\u062e\u062f\u0645\u0629 \u0627\u0644\u063a\u0631\u0641",
	"Laundry Service": "\u062e\u062f\u0645\u0629 \u063a\u0633\u064a\u0644",
	Housekeeping: "\u062e\u062f\u0645\u0629 \u062a\u0646\u0638\u064a\u0641 \u0627\u0644\u063a\u0631\u0641",
	"Free Parking": "\u0645\u0648\u0642\u0641 \u0645\u062c\u0627\u0646\u064a",
	"Breakfast Included": "\u0627\u0644\u0625\u0641\u0637\u0627\u0631 \u0645\u0634\u0645\u0648\u0644",
	"Accessible Rooms": "\u063a\u0631\u0641 \u0644\u0630\u0648\u064a \u0627\u0644\u0627\u062d\u062a\u064a\u0627\u062c\u0627\u062a",
	"Sea View": "\u0625\u0637\u0644\u0627\u0644\u0629 \u0628\u062d\u0631",
	"Street View": "\u0625\u0637\u0644\u0627\u0644\u0629 \u0634\u0627\u0631\u0639",
	"Garden View": "\u0625\u0637\u0644\u0627\u0644\u0629 \u062d\u062f\u064a\u0642\u0629",
	"City View": "\u0625\u0637\u0644\u0627\u0644\u0629 \u0645\u062f\u064a\u0646\u0629",
	"Mountain View": "\u0625\u0637\u0644\u0627\u0644\u0629 \u062c\u0628\u0644",
	"Holy Haram View": "\u0625\u0637\u0644\u0627\u0644\u0629 \u0627\u0644\u062d\u0631\u0645",
	"Prayer Mat": "\u0633\u062c\u0627\u062f\u0629 \u0635\u0644\u0627\u0629",
	"Holy Quran": "\u0627\u0644\u0642\u0631\u0622\u0646 \u0627\u0644\u0643\u0631\u064a\u0645",
	"Islamic Television Channels": "\u0642\u0646\u0648\u0627\u062a \u0625\u0633\u0644\u0627\u0645\u064a\u0629",
	"Shuttle Service to Haram": "\u062e\u062f\u0645\u0629 \u0646\u0642\u0644 \u0644\u0644\u062d\u0631\u0645",
	"Nearby Souks/Markets": "\u0623\u0633\u0648\u0627\u0642 \u0642\u0631\u064a\u0628\u0629",
	"Complimentary Zamzam Water": "\u0645\u0627\u0621 \u0632\u0645\u0632\u0645 \u0645\u062c\u0627\u0646\u064a",
	"Halal-certified Restaurant": "\u0645\u0637\u0639\u0645 \u062d\u0644\u0627\u0644",
};

const ROOM_TYPE_FALLBACK_LABELS = {
	singleRooms: {
		en: "single room",
		ar: "\u063a\u0631\u0641\u0629 \u0641\u0631\u062f\u064a\u0629",
	},
	doubleRooms: {
		en: "double room",
		ar: "\u063a\u0631\u0641\u0629 \u0645\u0632\u062f\u0648\u062c\u0629",
	},
	tripleRooms: {
		en: "triple room",
		ar: "\u063a\u0631\u0641\u0629 \u062b\u0644\u0627\u062b\u064a\u0629",
	},
	quadRooms: {
		en: "quad room",
		ar: "\u063a\u0631\u0641\u0629 \u0631\u0628\u0627\u0639\u064a\u0629",
	},
	familyRooms: {
		en: "quintuple room",
		ar: "\u063a\u0631\u0641\u0629 \u062e\u0645\u0627\u0633\u064a\u0629",
	},
	individualBed: {
		en: "shared room",
		ar: "\u063a\u0631\u0641\u0629 \u0645\u0634\u062a\u0631\u0643\u0629",
	},
	standardRooms: {
		en: "standard room",
		ar: "\u063a\u0631\u0641\u0629 \u0642\u064a\u0627\u0633\u064a\u0629",
	},
	twinRooms: {
		en: "twin room",
		ar: "\u063a\u0631\u0641\u0629 \u062a\u0648\u0623\u0645",
	},
	queenRooms: {
		en: "queen room",
		ar: "\u063a\u0631\u0641\u0629 \u0643\u0648\u064a\u0646",
	},
	kingRooms: {
		en: "king room",
		ar: "\u063a\u0631\u0641\u0629 \u0643\u064a\u0646\u062c",
	},
	studioRooms: {
		en: "studio room",
		ar: "\u063a\u0631\u0641\u0629 \u0627\u0633\u062a\u0648\u062f\u064a\u0648",
	},
	suite: {
		en: "suite",
		ar: "\u062c\u0646\u0627\u062d",
	},
	masterSuite: {
		en: "master suite",
		ar: "\u062c\u0646\u0627\u062d \u0631\u0626\u064a\u0633\u064a",
	},
};

const joinFeatureList = (items = [], language = "English") => {
	const cleanItems = normalizeFeatureList(items).map((item) =>
		language === "Arabic" ? ARABIC_FEATURE_LABELS[item] || item : item
	);
	if (!cleanItems.length) return "";
	if (cleanItems.length === 1) return cleanItems[0];
	const separator = language === "Arabic" ? "\u060c " : ", ";
	const lastSeparator = language === "Arabic" ? " \u0648" : ", and ";
	return `${cleanItems.slice(0, -1).join(separator)}${lastSeparator}${
		cleanItems[cleanItems.length - 1]
	}`;
};

const buildFallbackDescription = ({
	name = "",
	roomType = "",
	amenities = [],
	views = [],
	extraAmenities = [],
	language = "English",
} = {}) => {
	const rawName = compactText(name, 120);
	const typeLabel = ROOM_TYPE_FALLBACK_LABELS[roomType] || {};
	const cleanName =
		language === "Arabic"
			? rawName && ARABIC_RE.test(rawName)
				? rawName
				: typeLabel.ar || rawName || "\u063a\u0631\u0641\u0629 \u0641\u0646\u062f\u0642\u064a\u0629"
			: rawName && !ARABIC_RE.test(rawName)
			  ? rawName
			  : typeLabel.en || rawName || "room";
	const featureList = joinFeatureList(
		[
			...normalizeFeatureList(amenities),
			...normalizeFeatureList(views),
			...normalizeFeatureList(extraAmenities),
		],
		language
	);
	if (language === "Arabic") {
		const roomName =
			cleanName || "\u063a\u0631\u0641\u0629 \u0641\u0646\u062f\u0642\u064a\u0629";
		return compactText(
			featureList
				? `${roomName} \u0645\u0631\u064a\u062d\u0629 \u0645\u0639 ${featureList}\u060c \u0645\u0635\u0645\u0645\u0629 \u0644\u0625\u0642\u0627\u0645\u0629 \u0647\u0627\u062f\u0626\u0629 \u0648\u0645\u0646\u0627\u0633\u0628\u0629.`
				: `${roomName} \u0645\u0631\u064a\u062d\u0629 \u0648\u0645\u0635\u0645\u0645\u0629 \u0644\u0625\u0642\u0627\u0645\u0629 \u0647\u0627\u062f\u0626\u0629 \u0648\u0645\u0646\u0627\u0633\u0628\u0629.`,
			1200
		);
	}
	return compactText(
		featureList
			? `A comfortable ${cleanName} with ${featureList}, designed for a relaxed hotel stay.`
			: `A comfortable ${cleanName} designed for a relaxed hotel stay.`,
		1200
	);
};

const fallbackRoomText = ({
	name = "",
	description = "",
	roomType = "",
	amenities = [],
	views = [],
	extraAmenities = [],
} = {}) => {
	const cleanName = compactText(name, 180);
	const cleanDescription = compactText(description, 1200);
	const nameIsArabic = ARABIC_RE.test(cleanName);
	const descriptionIsArabic = ARABIC_RE.test(cleanDescription);
	const generatedEnglishDescription = buildFallbackDescription({
		name: cleanName,
		roomType,
		amenities,
		views,
		extraAmenities,
		language: "English",
	});
	const generatedArabicDescription = buildFallbackDescription({
		name: cleanName,
		roomType,
		amenities,
		views,
		extraAmenities,
		language: "Arabic",
	});
	return {
		displayName: nameIsArabic ? cleanName : cleanName,
		displayName_OtherLanguage: nameIsArabic ? cleanName : cleanName,
		description:
			cleanDescription && !descriptionIsArabic
				? cleanDescription
				: generatedEnglishDescription,
		description_OtherLanguage:
			cleanDescription && descriptionIsArabic
				? cleanDescription
				: generatedArabicDescription,
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
	amenities = [],
	views = [],
	extraAmenities = [],
} = {}) => {
	const cleanName = compactText(name, 180);
	const cleanDescription = compactText(description, 1200);
	const cleanAmenities = normalizeFeatureList(amenities);
	const cleanViews = normalizeFeatureList(views);
	const cleanExtraAmenities = normalizeFeatureList(extraAmenities);
	const fallbackPayload = {
		name: cleanName,
		description: cleanDescription,
		roomType,
		amenities: cleanAmenities,
		views: cleanViews,
		extraAmenities: cleanExtraAmenities,
	};
	if (!cleanName) {
		return {
			...fallbackRoomText(fallbackPayload),
			aiSkippedReason: "room_name_required",
		};
	}

	const apiKey = process.env.OPENAI_API_KEY || process.env.CHATGPT_API_TOKEN || "";
	if (!apiKey || !/^sk-/.test(String(apiKey).trim())) {
		return {
			...fallbackRoomText(fallbackPayload),
			aiSkippedReason: "openai_not_configured",
		};
	}

	const model = pickOpenAIModel("writer");
	const client = new OpenAI({ apiKey });
	const prompt = [
		"You are a professional bilingual hotel PMS copy editor.",
		"The platform supports only English and Arabic.",
		"Given one room name, an optional existing room description, and selected room features, produce polished English and polished Arabic.",
		"If the description is blank, write a short hotel-room description from the room name, room type, and selected features.",
		"Keep the room name concise and hotel-appropriate. Use only the provided features; do not invent amenities, prices, or policies.",
		"Keep each description warm, natural, and no longer than two short sentences.",
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
							amenities: cleanAmenities,
							views: cleanViews,
							extraAmenities: cleanExtraAmenities,
						}),
					},
				],
			})
		);
		const content = response?.choices?.[0]?.message?.content || "";
		const parsed = safeJsonParse(content);
		if (!parsed) throw new Error("AI response was not JSON.");
		return {
			...normalizeAiRoomText(parsed, fallbackPayload),
			aiApplied: true,
			aiModel: model,
		};
	} catch (error) {
		return {
			...fallbackRoomText(fallbackPayload),
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
