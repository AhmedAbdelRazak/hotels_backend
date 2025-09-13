// ai-agent/learning.js
const AiAgentLearning = require("../models/aiagent_learning");
const AiAgentLearningBatch = require("../models/aiagent_learning_batch");

async function fetchGuidanceForAgent({ hotelId, limit = 24 } = {}) {
	const filter = hotelId ? { hotelId } : {};
	const docs = await AiAgentLearning.find(filter)
		.sort({ updatedAt: -1 })
		.limit(Math.min(limit, 64))
		.lean();

	const latestBatch = await AiAgentLearningBatch.findOne({})
		.sort({ createdAt: -1 })
		.lean();

	const dedupe = (arr, max) =>
		Array.from(
			new Set((arr || []).map((s) => String(s).trim()).filter(Boolean))
		).slice(0, max);

	const decisions = dedupe(
		docs.flatMap((d) => d.decisionRules),
		16
	);
	const recommendations = dedupe(
		docs.flatMap((d) => d.recommendedResponses),
		16
	);

	let combinedSummary = "";
	let topics = [];
	let playbookTitles = [];
	if (latestBatch) {
		combinedSummary = String(latestBatch.combinedSummary || "");
		topics = dedupe(latestBatch.topics || [], 8);
		playbookTitles = dedupe(
			(latestBatch.combinedPlaybook || []).map((p) => p.title),
			8
		);
	}

	return {
		bullets: { decisions, recommendations },
		combined: { summary: combinedSummary, topics, playbookTitles },
	};
}

module.exports = { fetchGuidanceForAgent };
