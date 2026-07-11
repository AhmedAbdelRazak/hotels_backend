const assert = require("assert");

const ENV_KEYS = [
	"OPENAI_MODEL",
	"OPENAI_REASONING_MODEL",
	"OPENAI_REASONING_EFFORT",
	"OPENAI_CHATBOT_MODEL",
	"OPENAI_CHATBOT_FAST_MODEL",
	"OPENAI_CHATBOT_ANALYSIS_MODEL",
	"OPENAI_CHATBOT_BOOKING_MODEL",
	"OPENAI_CHATBOT_PLANNER_MODEL",
	"OPENAI_CHATBOT_REASONING_MODEL",
	"OPENAI_CHATBOT_NLU_MODEL",
	"OPENAI_CHATBOT_WRITER_MODEL",
	"OPENAI_CHATBOT_REPLY_MODEL",
	"OPENAI_CHATBOT_POLISH_MODEL",
	"OPENAI_CHATBOT_REASONING_EFFORT",
	"OPENAI_CHATBOT_BOOKING_REASONING_EFFORT",
	"OPENAI_CHATBOT_PLANNER_REASONING_EFFORT",
	"OPENAI_CHATBOT_ANALYSIS_REASONING_EFFORT",
	"OPENAI_CHATBOT_NLU_REASONING_EFFORT",
	"OPENAI_CHATBOT_WRITER_REASONING_EFFORT",
	"OPENAI_CHATBOT_REPLY_REASONING_EFFORT",
	"OPENAI_CHATBOT_POLISH_REASONING_EFFORT",
	"OPENAI_CHATBOT_SUPPORT_REASONING_EFFORT",
	"AI_OPENAI_RESPONSE_CONTINUATION",
];

const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

const clearEnv = () => {
	for (const key of ENV_KEYS) delete process.env[key];
};

const restoreEnv = () => {
	for (const key of ENV_KEYS) {
		if (originalEnv[key] === undefined) delete process.env[key];
		else process.env[key] = originalEnv[key];
	}
};

async function run() {
	clearEnv();
	process.env.OPENAI_MODEL = "gpt-5.4-mini";
	process.env.OPENAI_REASONING_MODEL = "gpt-5.4-mini";
	process.env.OPENAI_REASONING_EFFORT = "high";

	const modelConfig = require("../services/openaiModelConfig");
	const openaiCore = require("../aiagent/core/openai");
	const {
		normalizeReadyHotelOpenAiKnowledge,
	} = require("../aiagent/core/db");

	assert.strictEqual(modelConfig.pickOpenAIModel("default"), "gpt-5.4-mini");
	for (const kind of ["default", "reasoning", "writer", "nlu", "analysis"]) {
		assert.strictEqual(
			modelConfig.pickChatbotOpenAIModel(kind),
			"gpt-5.5",
			`generic OPENAI_MODEL must not override chatbot ${kind}`
		);
	}

	process.env.OPENAI_CHATBOT_MODEL = "gpt-5.5-chatbot-override";
	process.env.OPENAI_CHATBOT_NLU_MODEL = "gpt-5.5-nlu-override";
	assert.strictEqual(
		modelConfig.pickChatbotOpenAIModel("reasoning"),
		"gpt-5.5-chatbot-override"
	);
	assert.strictEqual(
		modelConfig.pickChatbotOpenAIModel("nlu"),
		"gpt-5.5-nlu-override"
	);
	delete process.env.OPENAI_CHATBOT_MODEL;
	delete process.env.OPENAI_CHATBOT_NLU_MODEL;

	assert.strictEqual(modelConfig.pickChatbotReasoningEffort("reasoning"), "medium");
	assert.strictEqual(modelConfig.pickChatbotReasoningEffort("writer"), "low");
	assert.strictEqual(modelConfig.pickChatbotReasoningEffort("nlu"), "low");
	assert.strictEqual(modelConfig.pickChatbotReasoningEffort("analysis"), "low");
	process.env.OPENAI_CHATBOT_REASONING_EFFORT = "low";
	assert.strictEqual(
		modelConfig.pickChatbotReasoningEffort("reasoning"),
		"medium",
		"planner effort must not drop below medium"
	);
	process.env.OPENAI_CHATBOT_WRITER_REASONING_EFFORT = "high";
	assert.strictEqual(modelConfig.pickChatbotReasoningEffort("writer"), "high");

	const body = openaiCore.buildResponsesBody({
		model: "gpt-5.5",
		messages: [{ role: "user", content: "Hotel facts, please." }],
		maxTokens: 4000,
		file_search_vector_store_id: "vs_hotel_123",
		file_search_max_results: 3,
	});
	assert.deepStrictEqual(body.tools, [
		{
			type: "file_search",
			vector_store_ids: ["vs_hotel_123"],
			max_num_results: 3,
		},
	]);
	const noVectorBody = openaiCore.buildResponsesBody({
		model: "gpt-5.5",
		messages: [{ role: "user", content: "Hello" }],
		maxTokens: 4000,
	});
	assert.strictEqual(noVectorBody.tools, undefined);
	assert.strictEqual(
		openaiCore.fileSearchToolForVectorStore("another_hotel_vector"),
		null
	);

	const contextA = openaiCore.responsesThreadContextKey({
		model: "gpt-5.5",
		vectorStoreId: "vs_hotel_123",
		factPackHash: "facts-a",
	});
	const contextB = openaiCore.responsesThreadContextKey({
		model: "gpt-5.5",
		vectorStoreId: "vs_hotel_456",
		factPackHash: "facts-a",
	});
	assert.notStrictEqual(contextA, contextB);
	assert.deepStrictEqual(
		openaiCore.resolveResponsesThreadContinuation({
			previousResponseId: "resp_123",
			previousContextKey: contextA,
			currentContextKey: contextB,
		}),
		{
			previousResponseId: "",
			threadReset: true,
			contextChanged: true,
		}
	);
	assert.strictEqual(
		openaiCore.initialOutputTokenLimit("reasoning", 650, "gpt-5.5") >= 4000,
		true
	);
	assert.strictEqual(
		openaiCore.getChatbotOpenAIRuntimeConfig().responseContinuationEnabled,
		false,
		"full transcript replay must not also use previous_response_id by default"
	);

	const timestamp = new Date("2026-07-10T12:00:00.000Z");
	const ready = normalizeReadyHotelOpenAiKnowledge({
		_id: "6a40b6a1a6efe70450536038",
		updatedAt: timestamp,
		openaiKnowledge: {
			provider: "openai",
			status: "ready",
			vectorStoreId: "vs_zad_ajyad",
			knowledgeVersion: 2,
			sourceUpdatedAt: timestamp,
		},
	});
	assert.strictEqual(ready.vectorStoreId, "vs_zad_ajyad");
	assert.strictEqual(
		normalizeReadyHotelOpenAiKnowledge({
			_id: "6a40b6a1a6efe70450536038",
			updatedAt: timestamp,
			openaiKnowledge: {
				provider: "openai",
				status: "ready",
				vectorStoreId: "vs_stale",
				sourceUpdatedAt: new Date("2026-07-10T11:59:59.000Z"),
			},
		}),
		null,
		"a stale ready vector must not be attached after a hotel update"
	);

	console.log("chatbot OpenAI integration checks passed");
}

run()
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
	})
	.finally(restoreEnv);
