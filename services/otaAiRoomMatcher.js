/** @format */

"use strict";

const OpenAI = require("openai");
const {
	pickOpenAIModel,
	buildChatCompletionBody,
} = require("./openaiModelConfig");

const DEFAULT_AI_ROOM_MATCH_CONFIDENCE = 0.6;
const DEFAULT_AI_ROOM_MATCH_MARGIN = 0.08;
const AI_ROOM_MATCH_BASES = new Set([
	"explicit_capacity",
	"semantic_name",
	"room_category",
	"translated_or_transliterated_name",
	"occupancy_only",
	"ambiguous",
	"no_plausible_match",
]);

const normalizeId = (value) =>
	String(value?._id || value?.id || value || "").trim();

const normalizeText = (value) =>
	String(value || "")
		.replace(/\s+/g, " ")
		.trim();

const roomCategory = (roomType = "") =>
	normalizeText(roomType)
		.replace(/Rooms?$/i, "")
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.toLowerCase();

const roomCandidate = (room = {}) => ({
	id: normalizeId(room),
	roomType: normalizeText(room.roomType || room.room_type),
	roomCategory: roomCategory(room.roomType || room.room_type),
	displayName: normalizeText(room.displayName || room.display_name),
	alternateName: normalizeText(room.displayName_OtherLanguage),
	description: normalizeText(room.description).slice(0, 320),
	alternateDescription: normalizeText(room.description_OtherLanguage).slice(0, 320),
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

const configuredMarginThreshold = () => {
	const configured = Number(process.env.OTA_AI_ROOM_MATCH_MIN_MARGIN);
	return Number.isFinite(configured) && configured >= 0.03 && configured <= 0.4
		? configured
		: DEFAULT_AI_ROOM_MATCH_MARGIN;
};

const rejectedDecision = ({
	decision = {},
	confidence = 0,
	threshold,
	marginThreshold,
	rejectionCode,
	reason,
} = {}) => ({
	matched: false,
	selectedRoomId: "",
	proposedRoomId: normalizeId(decision.selectedRoomId),
	runnerUpRoomId: normalizeId(decision.runnerUpRoomId),
	confidence: Number.isFinite(confidence) ? confidence : 0,
	runnerUpConfidence: Number.isFinite(Number(decision.runnerUpConfidence))
		? Number(decision.runnerUpConfidence)
		: 0,
	threshold,
	marginThreshold,
	basis: AI_ROOM_MATCH_BASES.has(decision.basis) ? decision.basis : "",
	rejectionCode,
	reason: normalizeText(reason || decision.reason).slice(0, 500),
});

const normalizeAiRoomDecision = (
	decision = {},
	candidates = [],
	{
		sourceCapacity = 0,
		minimumCapacity = 0,
		candidateCapacities = {},
	} = {}
) => {
	const selectedRoomId = normalizeId(decision.selectedRoomId);
	const confidence = Number(decision.confidence || 0);
	const candidate = candidates.find((item) => item.id === selectedRoomId);
	const threshold = configuredConfidenceThreshold();
	const marginThreshold = configuredMarginThreshold();
	const basis = AI_ROOM_MATCH_BASES.has(decision.basis) ? decision.basis : "";
	if (!candidate) {
		return rejectedDecision({
			decision,
			confidence,
			threshold,
			marginThreshold,
			rejectionCode: selectedRoomId ? "room_not_allowlisted" : "no_selection",
		});
	}
	if (!Number.isFinite(confidence) || confidence < threshold) {
		return rejectedDecision({
			decision,
			confidence,
			threshold,
			marginThreshold,
			rejectionCode: "below_confidence_threshold",
		});
	}
	if (!basis || ["ambiguous", "no_plausible_match"].includes(basis)) {
		return rejectedDecision({
			decision,
			confidence,
			threshold,
			marginThreshold,
			rejectionCode: "non_match_basis",
		});
	}

	const expectedCapacity = Number(sourceCapacity || 0);
	const selectedCapacity = Number(candidateCapacities[selectedRoomId] || 0);
	if (expectedCapacity > 0 && selectedCapacity !== expectedCapacity) {
		return rejectedDecision({
			decision,
			confidence,
			threshold,
			marginThreshold,
			rejectionCode: selectedCapacity
				? "explicit_capacity_conflict"
				: "pms_capacity_unknown",
			reason: selectedCapacity
				? `AI selection rejected because OTA capacity ${expectedCapacity} conflicts with PMS capacity ${selectedCapacity}.`
				: `AI selection rejected because OTA capacity ${expectedCapacity} is explicit but the selected PMS room has no reliable capacity.`,
		});
	}

	const requiredOccupancy = expectedCapacity
		? 0
		: Math.max(0, Number(minimumCapacity || 0));
	if (
		requiredOccupancy > 0 &&
		selectedCapacity > 0 &&
		selectedCapacity < requiredOccupancy
	) {
		return rejectedDecision({
			decision,
			confidence,
			threshold,
			marginThreshold,
			rejectionCode: "occupancy_exceeds_pms_capacity",
			reason: `AI selection rejected because ${requiredOccupancy} booked guests exceed the selected PMS room capacity ${selectedCapacity}.`,
		});
	}

	const runnerUpRoomId = normalizeId(decision.runnerUpRoomId);
	const runnerUpConfidence = runnerUpRoomId
		? Number(decision.runnerUpConfidence)
		: 0;
	const runnerUp = runnerUpRoomId
		? candidates.find((item) => item.id === runnerUpRoomId)
		: null;
	if (
		(runnerUpRoomId && (!runnerUp || runnerUpRoomId === selectedRoomId)) ||
		!Number.isFinite(runnerUpConfidence) ||
		runnerUpConfidence < 0 ||
		runnerUpConfidence > confidence
	) {
		return rejectedDecision({
			decision,
			confidence,
			threshold,
			marginThreshold,
			rejectionCode: "invalid_runner_up",
		});
	}
	const confidenceMargin = confidence - runnerUpConfidence;
	if (runnerUp && confidenceMargin < marginThreshold) {
		return rejectedDecision({
			decision,
			confidence,
			threshold,
			marginThreshold,
			rejectionCode: "ambiguous_margin",
			reason: `AI selection rejected because its ${confidenceMargin.toFixed(
				2
			)} confidence lead over the runner-up is below ${marginThreshold.toFixed(
				2
			)}.`,
		});
	}

	return {
		matched: true,
		selectedRoomId,
		proposedRoomId: selectedRoomId,
		runnerUpRoomId,
		confidence,
		runnerUpConfidence,
		confidenceMargin,
		threshold,
		marginThreshold,
		basis,
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
	minimumCapacity = 0,
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
	const candidateIds = candidates.map((candidate) => candidate.id);
	const nullableCandidateIdSchema = {
		type: ["string", "null"],
		enum: [...candidateIds, null],
	};
	const responseFormat = {
		type: "json_schema",
		json_schema: {
			name: "ota_pms_room_match",
			strict: true,
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					selectedRoomId: nullableCandidateIdSchema,
					confidence: { type: "number", minimum: 0, maximum: 1 },
					runnerUpRoomId: nullableCandidateIdSchema,
					runnerUpConfidence: {
						type: "number",
						minimum: 0,
						maximum: 1,
					},
					basis: {
						type: "string",
						enum: [...AI_ROOM_MATCH_BASES],
					},
					reason: { type: "string" },
				},
				required: [
					"selectedRoomId",
					"confidence",
					"runnerUpRoomId",
					"runnerUpConfidence",
					"basis",
					"reason",
				],
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
			provider: normalizeText(normalized.provider),
			bookedGuests: Number(normalized.totalGuests || 0),
			adults: Number(normalized.adults || 0),
			children: Number(normalized.children || 0),
			roomCount: Math.max(1, Number(normalized.roomCount || 1)),
			explicitCapacity: Number(sourceCapacity || 0),
			minimumCapacity: Number(minimumCapacity || 0),
		},
		deterministicHint: {
			matchType: normalizeText(deterministicMatch.matchType),
			mappedRoomType: normalizeText(deterministicMatch.mappedRoomType),
			nameSimilarity: Number(deterministicMatch.displayScore || 0),
		},
		pmsRooms: candidates.map((candidate) => ({
			...candidate,
			configuredCapacity: Number(candidateCapacities[candidate.id] || 0),
		})),
	};

	console.log("[ota-room-ai] start", {
		at: new Date().toISOString(),
		model,
		hotelId: payload.hotel.id,
		candidateCount: candidates.length,
		deterministicMatchType: deterministicMatch.matchType || "none",
	});
	let lastError;
	for (let attempt = 1; attempt <= 2; attempt += 1) {
		try {
			const response = await openai.chat.completions.create(
				buildChatCompletionBody({
					model,
					maxTokens: 800,
					response_format: responseFormat,
					messages: [
						{
							role: "system",
							content:
								"You are a constrained ranking engine that maps one OTA room title to the closest room already configured for the resolved hotel. Rank only pmsRooms and return only their IDs. Priority order: (1) an explicitly labeled bed/person capacity is a hard constraint; (2) semantic room class and purpose such as family, suite, twin, double, deluxe, or shared; (3) bed configuration, spelling, translation, transliteration, and meaningful modifiers; (4) booked occupancy only as a safety minimum and weak supporting clue. Never turn a family room into a quad room merely because four guests booked when a plausible family PMS room exists. An unlabeled suffix such as 'Room 2' is a listing/rate variant, not two beds or two people. configuredCapacity is authoritative when positive; ignore any contradictory incidental numbers in descriptions. Return the strongest candidate and runner-up. If no room is plausible, return null/no_plausible_match. If the two best rooms are effectively tied, return null/ambiguous. Confidence must reflect comparative evidence, not optimism. Never invent a room or ID. Return strict JSON.",
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
				minimumCapacity,
				candidateCapacities,
			});
			console.log("[ota-room-ai] done", {
				at: new Date().toISOString(),
				model,
				hotelId: payload.hotel.id,
				attempt,
				matched: normalizedDecision.matched,
				selectedRoomId: normalizedDecision.selectedRoomId || "",
				proposedRoomId: normalizedDecision.proposedRoomId || "",
				confidence: normalizedDecision.confidence,
				runnerUpConfidence: normalizedDecision.runnerUpConfidence,
				basis: normalizedDecision.basis || "",
				rejectionCode: normalizedDecision.rejectionCode || "",
			});
			return {
				usedAI: true,
				model,
				...normalizedDecision,
			};
		} catch (error) {
			lastError = error;
			const retryableStatus = [408, 409, 429, 500, 502, 503, 504].includes(
				Number(error?.status || error?.statusCode || 0)
			);
			const retryable =
				error instanceof SyntaxError ||
				retryableStatus ||
				/timeout|timed out|connection|socket|network/i.test(error?.message || "");
			if (!retryable || attempt === 2) break;
		}
	}
	console.error("[ota-room-ai] failed:", lastError?.message || "unknown error");
	return {
		usedAI: true,
		matched: false,
		model,
		error: lastError?.message || "unknown error",
	};
}

module.exports = {
	DEFAULT_AI_ROOM_MATCH_CONFIDENCE,
	DEFAULT_AI_ROOM_MATCH_MARGIN,
	activeRoomCandidates,
	normalizeAiRoomDecision,
	shouldAskAiForRoomMatch,
	matchOtaRoomWithOpenAi,
};
