// controllers/aiagent_training_chats.js
const OpenAI = require("openai");
const crypto = require("crypto");
const mongoose = require("mongoose");
const AiAgentLearning = require("../models/aiagent_learning");
const {
	buildChatCompletionBody,
	pickOpenAIModel,
} = require("../services/openaiModelConfig");

const MAX_RAW_LENGTH = 50000;
const MAX_MESSAGE_LENGTH = 3000;
const MAX_TURNS = 160;
const SUPPORT_NAME_HINTS = new Set([
	"aisha",
	"hana",
	"sara",
	"amira",
	"yasmin",
	"nadia",
	"support",
	"agent",
	"admin",
	"reservation",
	"reception",
]);

const cleanText = (value = "", max = MAX_RAW_LENGTH) =>
	String(value || "")
		.replace(/\u0000/g, "")
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.trim()
		.slice(0, max);

const normalizeId = (value) => String(value?._id || value || "").trim();

const isValidObjectId = (value) => mongoose.Types.ObjectId.isValid(value);

const stableHash = (value = "") =>
	crypto.createHash("sha256").update(String(value || "")).digest("hex");

let learningIndexesReady = false;
async function ensureManualLearningIndexes() {
	if (learningIndexesReady) return;
	const indexes = await AiAgentLearning.collection.indexes();
	for (const index of indexes) {
		const isCaseIdIndex = index.key && index.key.caseId === 1;
		const isFullUniqueCaseId =
			isCaseIdIndex && index.unique && !index.partialFilterExpression;
		if (isFullUniqueCaseId || (index.name === "caseId_1" && !index.unique)) {
			try {
				await AiAgentLearning.collection.dropIndex(index.name);
			} catch (_) {}
		}
	}

	const refreshed = await AiAgentLearning.collection.indexes();
	const hasPartialUniqueCaseId = refreshed.some(
		(index) =>
			index.key &&
			index.key.caseId === 1 &&
			index.unique &&
			index.partialFilterExpression
	);
	if (!hasPartialUniqueCaseId) {
		try {
			await AiAgentLearning.collection.createIndex(
				{ caseId: 1 },
				{
					unique: true,
					name: "caseId_unique_support_case",
					partialFilterExpression: { caseId: { $type: "objectId" } },
				}
			);
		} catch (_) {}
	}
	learningIndexesReady = true;
}

const sanitizeList = (values = [], maxItems = 12, maxLength = 80) =>
	Array.from(
		new Set(
			(Array.isArray(values) ? values : [])
				.map((item) => cleanText(item, maxLength).toLowerCase())
				.filter(Boolean)
		)
	).slice(0, maxItems);

const sanitizeConversation = (turns = []) =>
	(Array.isArray(turns) ? turns : [])
		.map((turn, index) => ({
			sequence: Number(turn.sequence || index + 1),
			speakerName: cleanText(turn.speakerName || turn.speaker || "", 90),
			role: ["client", "support", "system", "unknown"].includes(turn.role)
				? turn.role
				: "unknown",
			message: cleanText(turn.message || turn.text || "", MAX_MESSAGE_LENGTH),
		}))
		.filter((turn) => turn.message)
		.slice(0, MAX_TURNS);

const extractJson = (raw = "") => {
	const text = String(raw || "").trim();
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch (_) {}
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenced) {
		try {
			return JSON.parse(fenced[1]);
		} catch (_) {}
	}
	const objectMatch = text.match(/\{[\s\S]*\}$/);
	if (objectMatch) {
		try {
			return JSON.parse(objectMatch[0]);
		} catch (_) {}
	}
	return null;
};

const tokenize = (text = "") =>
	String(text || "")
		.toLowerCase()
		.replace(/https?:\/\/\S+/g, " ")
		.replace(/[^a-z0-9\u0600-\u06FF\s]/gi, " ")
		.split(/\s+/)
		.map((word) => word.trim())
		.filter((word) => word.length >= 4);

const inferKeywords = (text = "") => {
	const counts = new Map();
	tokenize(text).forEach((word) => {
		if (
			[
				"client",
				"agent",
				"hello",
				"thanks",
				"thank",
				"please",
				"your",
				"with",
				"that",
				"this",
			].includes(word)
		) {
			return;
		}
		counts.set(word, (counts.get(word) || 0) + 1);
	});
	return Array.from(counts.entries())
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, 10)
		.map(([word]) => word);
};

const stripChatExportNoise = (line = "") =>
	line
		.replace(/^\s*\[?\d{1,2}[/:.-]\d{1,2}(?:[/:.-]\d{2,4})?,?\s+\d{1,2}:\d{2}(?:\s?[AP]M)?\]?\s*-?\s*/i, "")
		.replace(/^\s*\[?\d{1,2}:\d{2}(?:\s?[AP]M)?\]?\s*-?\s*/i, "")
		.trim();

const fallbackParseChat = (rawText = "") => {
	const turns = [];
	let current = null;
	const lines = cleanText(rawText)
		.split("\n")
		.map(stripChatExportNoise)
		.map((line) => line.trim())
		.filter(Boolean);

	for (const line of lines) {
		const match = line.match(/^([^:：]{1,80})[:：]\s*(.*)$/);
		if (match) {
			if (current?.message) turns.push(current);
			current = {
				speakerName: cleanText(match[1], 80),
				message: cleanText(match[2], MAX_MESSAGE_LENGTH),
			};
		} else if (current) {
			current.message = cleanText(
				`${current.message}\n${line}`,
				MAX_MESSAGE_LENGTH
			);
		} else {
			current = { speakerName: "Client", message: line };
		}
	}
	if (current?.message) turns.push(current);

	const speakerStats = new Map();
	turns.forEach((turn) => {
		const key = turn.speakerName || "Unknown";
		const lowerName = key.toLowerCase();
		const lowerMsg = turn.message.toLowerCase();
		const stat = speakerStats.get(key) || { support: 0, client: 0 };
		if (SUPPORT_NAME_HINTS.has(lowerName)) stat.support += 4;
		if (
			/\b(of course|available|availability|reservation|booking team|please send|check.?in|check.?out|we can|we have)\b/i.test(
				lowerMsg
			)
		) {
			stat.support += 2;
		}
		if (/\b(i want|i need|can i|do you|how much|price|book|reserve)\b/i.test(lowerMsg)) {
			stat.client += 2;
		}
		speakerStats.set(key, stat);
	});

	let supportSpeaker = "";
	for (const [speaker, stat] of speakerStats.entries()) {
		if (!supportSpeaker || stat.support > (speakerStats.get(supportSpeaker)?.support || 0)) {
			supportSpeaker = speaker;
		}
	}
	if ((speakerStats.get(supportSpeaker)?.support || 0) <= 0) supportSpeaker = "";

	const conversation = turns.map((turn, index) => ({
		sequence: index + 1,
		speakerName: turn.speakerName,
		role: supportSpeaker && turn.speakerName === supportSpeaker ? "support" : "client",
		message: turn.message,
	}));

	const firstClient = conversation.find((turn) => turn.role === "client");
	const keywords = inferKeywords(rawText);
	return {
		chatTitle: cleanText(
			firstClient?.message || "Imported support training chat",
			90
		),
		chatKeywords: keywords,
		language: /[\u0600-\u06FF]/.test(rawText) ? "Arabic" : "English",
		summary: "Imported employee chat example for AI support learning.",
		participants: Array.from(speakerStats.keys()).map((speaker) => ({
			speakerName: speaker,
			role: supportSpeaker && speaker === supportSpeaker ? "support" : "client",
		})),
		customerIntent: "",
		supportResolution: "",
		learningNotes: [],
		responseGuidance: [],
		conversation,
		confidenceScore: supportSpeaker ? 0.55 : 0.35,
	};
};

const pickModel = () => pickOpenAIModel("analysis");

const hasUsableOpenAIKey = () =>
	/^sk-/.test(String(process.env.OPENAI_API_KEY || process.env.CHATGPT_API_TOKEN || "").trim());

async function cleanChatWithOpenAI(rawText) {
	if (!hasUsableOpenAIKey()) {
		return { ...fallbackParseChat(rawText), aiCleaned: false, analysisModel: "" };
	}

	const apiKey = String(
		process.env.OPENAI_API_KEY || process.env.CHATGPT_API_TOKEN || ""
	).trim();
	const model = pickModel();
	try {
		const client = new OpenAI({ apiKey });
		const messages = [
			{
				role: "system",
				content: [
					"You clean and structure hotel support chats pasted from WhatsApp, Messenger, or similar tools.",
					"Return valid JSON only.",
					"Fix obvious spacing, duplicated line breaks, and simple spelling issues without changing meaning.",
					"Infer who is the client and who is the support employee from names, wording, and context.",
					"Preserve useful hospitality details: hotel names, dates, room types, prices, payment links, cancellation/update cues, and tone.",
					"Do not invent facts that are not in the chat.",
				].join(" "),
			},
			{
				role: "user",
				content: JSON.stringify({
					rawChat: rawText,
					requiredSchema: {
						chatTitle: "short descriptive title",
						chatKeywords: ["keyword"],
						language: "English/Arabic/etc",
						summary: "brief operational summary",
						participants: [
							{
								speakerName: "name from chat",
								role: "client|support|system|unknown",
							},
						],
						customerIntent: "what the guest wanted",
						supportResolution: "how support handled it",
						learningNotes: ["reusable lesson for the AI chatbot"],
						responseGuidance: ["short rule the AI should follow in similar chats"],
						confidenceScore: 0.0,
						conversation: [
							{
								sequence: 1,
								speakerName: "name",
								role: "client|support|system|unknown",
								message: "cleaned message",
							},
						],
					},
				}),
			},
		];

		const response = await client.chat.completions.create(buildChatCompletionBody({
			model,
			messages,
			response_format: { type: "json_object" },
			temperature: 0.1,
			maxTokens: 2200,
		}));

		const parsed = extractJson(response.choices?.[0]?.message?.content || "");
		if (!parsed) {
			return {
				...fallbackParseChat(rawText),
				aiCleaned: false,
				analysisModel: model,
			};
		}
		return { ...parsed, aiCleaned: true, analysisModel: model };
	} catch (error) {
		console.error("[aiagent-training] OpenAI cleanup fallback:", error?.message || error);
		return { ...fallbackParseChat(rawText), aiCleaned: false, analysisModel: model };
	}
}

const normalizeCleanedChat = (cleaned = {}, rawText = "") => {
	const fallback = fallbackParseChat(rawText);
	const conversation = sanitizeConversation(cleaned.conversation);
	const title =
		cleanText(cleaned.chatTitle, 140) ||
		cleanText(fallback.chatTitle, 140) ||
		"Imported support training chat";
	return {
		chatTitle: title,
		chatKeywords: sanitizeList(
			cleaned.chatKeywords?.length ? cleaned.chatKeywords : inferKeywords(rawText),
			14,
			60
		),
		language: cleanText(cleaned.language || fallback.language || "English", 80),
		summary: cleanText(cleaned.summary || fallback.summary, 2500),
		participants: (Array.isArray(cleaned.participants)
			? cleaned.participants
			: fallback.participants
		)
			.map((participant) => ({
				speakerName: cleanText(participant.speakerName, 90),
				role: ["client", "support", "system", "unknown"].includes(
					participant.role
				)
					? participant.role
					: "unknown",
			}))
			.filter((participant) => participant.speakerName)
			.slice(0, 12),
		customerIntent: cleanText(cleaned.customerIntent || "", 500),
		supportResolution: cleanText(cleaned.supportResolution || "", 800),
		learningNotes: sanitizeList(cleaned.learningNotes, 12, 220),
		responseGuidance: sanitizeList(cleaned.responseGuidance, 12, 220),
		conversation: conversation.length ? conversation : fallback.conversation,
		confidenceScore: Math.max(
			0,
			Math.min(1, Number(cleaned.confidenceScore || fallback.confidenceScore || 0))
		),
		aiCleaned: !!cleaned.aiCleaned,
		analysisModel: cleanText(cleaned.analysisModel || "", 80),
	};
};

const publicChat = (doc = {}) => ({
	_id: doc._id,
	chatTitle: doc.chatTitle,
	chatKeywords: doc.chatKeywords || [],
	conversation: doc.conversation || [],
	summary: doc.summary || "",
	language: doc.language || "",
	participants: doc.participants || [],
	customerIntent: doc.customerIntent || "",
	supportResolution: doc.supportResolution || "",
	learningNotes: doc.learningNotes || [],
	responseGuidance: doc.responseGuidance || [],
	hotelId: doc.hotelId || null,
	hotelName: doc.hotelName || "",
	source: doc.source || "manual_paste",
	aiCleaned: !!doc.aiCleaned,
	analysisModel: doc.analysisModel || "",
	confidenceScore: doc.confidenceScore || 0,
	status: doc.status || "active",
	createdBy: doc.createdBy || {},
	createdAt: doc.createdAt,
	updatedAt: doc.updatedAt,
});

exports.createTrainingChat = async (req, res) => {
	try {
		await ensureManualLearningIndexes();
		const rawText = cleanText(
			req.body?.rawText || req.body?.chatText || req.body?.text || ""
		);
		if (rawText.length < 8) {
			return res.status(400).json({
				error: "Please paste a chat conversation before submitting.",
				errorArabic: "\u064a\u0631\u062c\u0649 \u0644\u0635\u0642 \u0646\u0635 \u0627\u0644\u0645\u062d\u0627\u062f\u062b\u0629 \u0642\u0628\u0644 \u0627\u0644\u0625\u0631\u0633\u0627\u0644.",
			});
		}

		const cleaned = normalizeCleanedChat(await cleanChatWithOpenAI(rawText), rawText);
		const hotelId = normalizeId(req.body?.hotelId);
		const createdById = normalizeId(req.profile?._id);
		const doc = await AiAgentLearning.create({
			...cleaned,
			sourceType: "manual_chat",
			caseId: null,
			supportCaseId: null,
			sourceCaseId: null,
			hotelId: isValidObjectId(hotelId) ? hotelId : null,
			hotelName: cleanText(req.body?.hotelName || "", 180),
			source: ["manual_paste", "messenger", "whatsapp", "other"].includes(
				req.body?.source
			)
				? req.body.source
				: "manual_paste",
			rawText,
			sourceHash: stableHash(rawText),
			messageCount: cleaned.conversation.length,
			model: cleaned.analysisModel || "",
			status: "active",
			createdBy: {
				userId: isValidObjectId(createdById) ? createdById : null,
				name: cleanText(req.profile?.name || "", 120),
				email: cleanText(req.profile?.email || "", 180),
			},
		});

		return res.status(201).json({ ok: true, chat: publicChat(doc) });
	} catch (error) {
		console.error("[aiagent-training] create error:", error?.message || error);
		return res.status(500).json({
			error: error?.message || "Could not save training chat.",
			errorArabic:
				"\u062a\u0639\u0630\u0631 \u062d\u0641\u0638 \u0645\u062d\u0627\u062f\u062b\u0629 \u0627\u0644\u062a\u0639\u0644\u064a\u0645.",
		});
	}
};

exports.listTrainingChats = async (req, res) => {
	try {
		await ensureManualLearningIndexes();
		const limit = Math.min(
			Math.max(parseInt(req.query?.limit || "30", 10) || 30, 1),
			100
		);
		const page = Math.max(parseInt(req.query?.page || "1", 10) || 1, 1);
		const filter = { sourceType: "manual_chat" };
		if (req.query?.includeArchived !== "true") filter.status = "active";
		const hotelId = normalizeId(req.query?.hotelId);
		if (isValidObjectId(hotelId)) filter.hotelId = hotelId;
		const keyword = cleanText(req.query?.keyword || req.query?.q || "", 80).toLowerCase();
		if (keyword) {
			filter.$or = [
				{ chatTitle: new RegExp(keyword, "i") },
				{ chatKeywords: keyword },
				{ summary: new RegExp(keyword, "i") },
			];
		}

		const [docs, total] = await Promise.all([
			AiAgentLearning.find(filter)
				.sort({ updatedAt: -1, createdAt: -1 })
				.skip((page - 1) * limit)
				.limit(limit)
				.lean()
				.exec(),
			AiAgentLearning.countDocuments(filter),
		]);

		return res.json({
			ok: true,
			count: docs.length,
			total,
			page,
			limit,
			chats: docs.map(publicChat),
		});
	} catch (error) {
		console.error("[aiagent-training] list error:", error?.message || error);
		return res.status(500).json({
			error: "Could not load training chats.",
			errorArabic:
				"\u062a\u0639\u0630\u0631 \u062a\u062d\u0645\u064a\u0644 \u0645\u062d\u0627\u062f\u062b\u0627\u062a \u0627\u0644\u062a\u0639\u0644\u064a\u0645.",
		});
	}
};

exports.archiveTrainingChat = async (req, res) => {
	try {
		await ensureManualLearningIndexes();
		const id = normalizeId(req.params?.id);
		if (!isValidObjectId(id)) {
			return res.status(400).json({ error: "Invalid training chat id." });
		}
		const doc = await AiAgentLearning.findOneAndUpdate(
			{ _id: id, sourceType: "manual_chat" },
			{ $set: { status: "archived", updatedAt: new Date() } },
			{ new: true }
		)
			.lean()
			.exec();
		if (!doc) return res.status(404).json({ error: "Training chat not found." });
		return res.json({ ok: true, chat: publicChat(doc) });
	} catch (error) {
		console.error("[aiagent-training] archive error:", error?.message || error);
		return res.status(500).json({ error: "Could not archive training chat." });
	}
};
