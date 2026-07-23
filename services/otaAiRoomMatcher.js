/** @format */

"use strict";

const OpenAI = require("openai");
const {
	pickOpenAIModel,
	buildChatCompletionBody,
} = require("./openaiModelConfig");

const DEFAULT_AI_ROOM_MATCH_CONFIDENCE = 0.8;

const normalizeId = (value) =>
	String(value?._id || value?.id || value || "").trim();

const normalizeText = (value) =>
	String(value || "")
		.replace(/\s+/g, " ")
		.trim();

const roomCandidate = (room = {}) => ({
	id: normalizeId(room),
	roomType: normalizeText(room.roomType || room.room_type),
	displayName: normalizeText(room.displayName || room.display_name),
	alternateName: normalizeText(room.displayName_OtherLanguage),
	description: normalizeText(
		room.description || room.description_OtherLanguage
	).slice(0, 280),
	bedsCount: Number(room.bedsCount || 0),
	roomForGender: normalizeText(room.roomForGender),
});

const activeRoomCandidates = (hotelDetails = {}) =>
	(Array.isArray(hotelDetails.roomCountDetails)
		? hotelDetails.roomCountDetails
		: []
	)
		.filter((room) => room && room.activeRoom !== false && normalizeId(room))
		.map(roomCandidate);

const configuredConfidenceThreshold = () => {
	const configured = Number(process.env.OTA_AI_ROOM_MATCH_MIN_CONFIDENCE);
	return Number.isFinite(configured) && configured >= 0.5 && configured <= 1
		? configured
		: DEFAULT_AI_ROOM_MATCH_CONFIDENCE;
};

const normalizeAiRoomDecision = (
	decision = {},
	candidates = [],
	{ sourceCapacity = 0, candidateCapacities = {} } = {}
) => {
	const selectedRoomId = normalizeId(decision.selectedRoomId);
	const confidence = Number(decision.confidence || 0);
	const candidate = candidates.find((item) => item.id === selectedRoomId);
	const threshold = configuredConfidenceThreshold();
	if (!candidate || !Number.isFinite(confidence) || confidence < threshold) {
		return {
			matched: false,
			selectedRoomId: "",
			confidence: Number.isFinite(confidence) ? confidence : 0,
			threshold,
			reason: normalizeText(decision.reason),
		};
	}

	const expectedCapacity = Number(sourceCapacity || 0);
	const selectedCapacity = Number(candidateCapacities[selectedRoomId] || 0);
	if (
		expectedCapacity > 0 &&
		selectedCapacity > 0 &&
		selectedCapacity !== expectedCapacity
	) {
		return {
			matched: false,
			selectedRoomId: "",
			confidence,
			threshold,
			reason: `AI selection rejected because OTA capacity ${expectedCapacity} conflicts with PMS capacity ${selectedCapacity}.`,
		};
	}

	return {
		matched: true,
		selectedRoomId,
		confidence,
		threshold,
		reason: normalizeText(decision.reason).slice(0, 500),
		candidate,
	};
};

const shouldAskAiForRoomMatch = (roomMatch = {}) =>
	!roomMatch.roomDetails ||
	!["exact_display", "explicit_capacity"].includes(roomMatch.matchType);

const getOpenAiClient = () => {
	const apiKey = process.env.CHATGPT_API_TOKEN || process.env.OPENAI_API_KEY;
	return apiKey ? new OpenAI({ apiKey }) : null;
};

async function matchOtaRoomWithOpenAi({
	hotelDetails,
	normalized = {},
	deterministicMatch = {},
	sourceCapacity = 0,
	candidateCapacities = {},
	client = null,
} = {}) {
	const candidates = activeRoomCandidates(hotelDetails);
	if (!normalizeText(normalized.roomName) || !candidates.length) {
		return { usedAI: false, matched: false, skipReason: "missing_room_context" };
	}
	if (!shouldAskAiForRoomMatch(deterministicMatch)) {
		return {
			usedAI: false,
			matched: false,
			skipReason: "deterministic_room_match_is_exact",
		};
	}

	const openai = client || getOpenAiClient();
	if (!openai) {
		return { usedAI: false, matched: false, skipReason: "openai_not_configured" };
	}

	const model = pickOpenAIModel("analysis");
	const responseFormat = {
		type: "json_schema",
		json_schema: {
			name: "ota_pms_room_match",
			strict: true,
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					selectedRoomId: { type: ["string", "null"] },
					confidence: { type: "number", minimum: 0, maximum: 1 },
					reason: { type: "string" },
				},
				required: ["selectedRoomId", "confidence", "reason"],
			},
		},
	};
	const payload = {
		hotel: {
			id: normalizeId(hotelDetails),
			name: normalizeText(hotelDetails?.hotelName),
		},
		otaRoom: {
			name: normalizeText(normalized.roomName),
			totalGuests: Number(normalized.totalGuests || 0),
			adults: Number(normalized.adults || 0),
			children: Number(normalized.children || 0),
			explicitCapacity: Number(sourceCapacity || 0),
		},
		pmsRooms: candidates.map((candidate) => ({
			...candidate,
			configuredCapacity: Number(candidateCapacities[candidate.id] || 0),
		})),
	};

	try {
		console.log("[ota-room-ai] start", {
			at: new Date().toISOString(),
			model,
			hotelId: payload.hotel.id,
			candidateCount: candidates.length,
			deterministicMatchType: deterministicMatch.matchType || "none",
		});
		const response = await openai.chat.completions.create(
			buildChatCompletionBody({
				model,
				maxTokens: 600,
				response_format: responseFormat,
				messages: [
					{
						role: "system",
						content:
							"You map one OTA room name to one room already configured in the resolved hotel's PMS. Choose only an ID from pmsRooms. Treat an explicit bed/person capacity in the OTA room name as a hard constraint. Compare room purpose, bed type, capacity, suite/family/standard category, spelling, translation, and transliteration. Occupancy is supporting context only and may be zero. If no PMS room is semantically plausible, or two candidates are equally plausible, return selectedRoomId null. Never invent a room or ID. Return strict JSON.",
					},
					{
						role: "user",
						content: JSON.stringify(payload),
					},
				],
			}),
			{ timeout: 12000 }
		);
		const content = response.choices?.[0]?.message?.content || "{}";
		const decision = JSON.parse(content);
		const normalizedDecision = normalizeAiRoomDecision(decision, candidates, {
			sourceCapacity,
			candidateCapacities,
		});
		console.log("[ota-room-ai] done", {
			at: new Date().toISOString(),
			model,
			hotelId: payload.hotel.id,
			matched: normalizedDecision.matched,
			selectedRoomId: normalizedDecision.selectedRoomId || "",
			confidence: normalizedDecision.confidence,
		});
		return {
			usedAI: true,
			model,
			...normalizedDecision,
		};
	} catch (error) {
		console.error("[ota-room-ai] failed:", error.message);
		return {
			usedAI: true,
			matched: false,
			model,
			error: error.message,
		};
	}
}

module.exports = {
	DEFAULT_AI_ROOM_MATCH_CONFIDENCE,
	activeRoomCandidates,
	normalizeAiRoomDecision,
	shouldAskAiForRoomMatch,
	matchOtaRoomWithOpenAi,
};
