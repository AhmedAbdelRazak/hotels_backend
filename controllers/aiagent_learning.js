// controllers/aiagent_learning.js
const OpenAI = require("openai");
const crypto = require("crypto");
const mongoose = require("mongoose");
const SupportCase = require("../models/supportcase");
const AiAgentLearning = require("../models/aiagent_learning");
const AiAgentLearningBatch = require("../models/aiagent_learning_batch");

// Env
const RAW_KEY =
	process.env.OPENAI_API_KEY || process.env.CHATGPT_API_TOKEN || "";
const RAW_ANALYSIS_MODEL = process.env.AI_ANALYSIS_MODEL || "gpt-4.1";

// Helpers
function looksLikeOpenAIKey(k) {
	return typeof k === "string" && /^sk-/.test(k.trim());
}
function sanitizeModelName(m) {
	if (!m) return null;
	const noHash = String(m).split("#")[0];
	const token = noHash.trim().split(/\s+/)[0];
	return token || null;
}
function maskKey(k) {
	if (!k) return "";
	const s = String(k);
	if (s.length <= 10) return "***";
	return `${s.slice(0, 4)}...${s.slice(-4)}`;
}
function stableHash(str) {
	return crypto
		.createHash("sha256")
		.update(String(str || ""))
		.digest("hex");
}
const ANALYSIS_MODEL = sanitizeModelName(RAW_ANALYSIS_MODEL) || "gpt-4.1";

// ---- One-time repair: drop legacy unique indexes & backfill fields
async function ensureLearningCollectionConsistency() {
	const fixes = { dropped: [], created: [], backfilled: 0, deduped: 0 };

	// 1) Drop legacy unique indexes that cause duplicates on null
	const idxList = await AiAgentLearning.collection.indexes();
	for (const idx of idxList) {
		// legacy unique on sourceCaseId
		if (idx.key && idx.key.sourceCaseId === 1 && idx.unique) {
			try {
				await AiAgentLearning.collection.dropIndex(idx.name);
				fixes.dropped.push(idx.name);
			} catch (_) {}
		}
		// legacy unique on supportCaseId
		if (idx.key && idx.key.supportCaseId === 1 && idx.unique) {
			try {
				await AiAgentLearning.collection.dropIndex(idx.name);
				fixes.dropped.push(idx.name);
			} catch (_) {}
		}
		// wrong non-unique caseId index (we want unique)
		if (idx.name === "caseId_1" && !idx.unique) {
			try {
				await AiAgentLearning.collection.dropIndex(idx.name);
				fixes.dropped.push(idx.name);
			} catch (_) {}
		}
	}

	// 2) Ensure unique index on caseId
	const idx2 = await AiAgentLearning.collection.indexes();
	const hasCaseUnique = idx2.some((i) => i.name === "caseId_1" && i.unique);
	if (!hasCaseUnique) {
		try {
			await AiAgentLearning.collection.createIndex(
				{ caseId: 1 },
				{ unique: true }
			);
			fixes.created.push("caseId_1(unique)");
		} catch (_) {}
	}

	// 3) Backfill fields so none are null (prevents future index surprises)
	const toFix = await AiAgentLearning.find(
		{
			$or: [
				{ caseId: { $exists: false } },
				{ supportCaseId: { $exists: false } },
				{ sourceCaseId: { $exists: false } },
			],
		},
		{ _id: 1, caseId: 1, supportCaseId: 1, sourceCaseId: 1 }
	).lean();

	if (toFix.length) {
		const ops = [];
		for (const d of toFix) {
			const caseId = d.caseId || d.supportCaseId || d.sourceCaseId || null;
			if (!caseId) continue;
			const $set = {};
			if (!d.caseId) $set.caseId = caseId;
			if (!d.supportCaseId) $set.supportCaseId = caseId;
			if (!d.sourceCaseId) $set.sourceCaseId = caseId;
			if (Object.keys($set).length) {
				ops.push({
					updateOne: { filter: { _id: d._id }, update: { $set } },
				});
			}
		}
		if (ops.length) {
			await AiAgentLearning.bulkWrite(ops, { ordered: false });
			fixes.backfilled = ops.length;
		}
	}

	return fixes;
}

// ---- LLM helpers
function toPairsForLLM(conversation = []) {
	return (conversation || [])
		.filter((m) => m && typeof m.message === "string")
		.map((m) => {
			const name = (m?.messageBy?.customerName || "").toLowerCase();
			const email = (m?.messageBy?.customerEmail || "").toLowerCase();
			const supportish =
				email === "management@xhotelpro.com" ||
				name.includes("admin") ||
				name.includes("support") ||
				name.includes("agent") ||
				name.includes("system");
			return {
				role: supportish ? "support" : "guest",
				text: String(m.message || "").trim(),
				when: m.date || null,
			};
		})
		.filter((t) => t.text);
}
function extractJSON(text) {
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch (_) {}
	const match = text.match(/\{[\s\S]*\}$/);
	if (match) {
		try {
			return JSON.parse(match[0]);
		} catch (_) {}
	}
	return null;
}
async function analyzeOneCase({ client, model, caseDoc }) {
	const pairs = toPairsForLLM(caseDoc.conversation || []);
	const messages = [
		{
			role: "system",
			content:
				"You are a senior hospitality B2C chat analyst. Read the chat turns and produce a language‑agnostic training brief for an AI receptionist. Output STRICT JSON only with the exact schema below. No extra text.",
		},
		{
			role: "user",
			content: `Return STRICT JSON:
{
  "summary": "1-2 paragraph neutral summary of the interaction",
  "steps": ["action step 1", "action step 2"],
  "decisionRules": [
    "if guest asks for price → fetch inventory",
    "if no check-in date, ask for it",
    "never ask for card/CVV in chat; use secure link"
  ],
  "recommendedResponses": [
    "Short reusable reply pattern 1",
    "Short reusable reply pattern 2"
  ],
  "commonQuestions": [
    "Recurring question 1",
    "Recurring question 2"
  ],
  "qualityScore": 0.0
}

Notes:
- Concise, no PII, language‑agnostic phrasing.
- Do NOT wrap in markdown. Do NOT add keys.

Context:
{
  "hotelId": "${String(caseDoc.hotelId)}",
  "caseId": "${String(caseDoc._id)}",
  "messageCount": ${(caseDoc.conversation || []).length},
  "turns": ${JSON.stringify(pairs).slice(0, 24000)}
}`,
		},
	];

	const r = await client.chat.completions.create({
		model,
		messages,
		temperature: 0.2,
		max_tokens: 900,
	});

	const raw = (r.choices?.[0]?.message?.content || "").trim();
	const json = extractJSON(raw);
	if (!json) throw new Error("Failed to parse JSON from model.");

	return {
		summary: json.summary || "",
		steps: Array.isArray(json.steps) ? json.steps : [],
		decisionRules: Array.isArray(json.decisionRules) ? json.decisionRules : [],
		recommendedResponses: Array.isArray(json.recommendedResponses)
			? json.recommendedResponses
			: [],
		commonQuestions: Array.isArray(json.commonQuestions)
			? json.commonQuestions
			: [],
		qualityScore: typeof json.qualityScore === "number" ? json.qualityScore : 0,
	};
}
async function buildCombinedBatchSummary({ client, model, learnings }) {
	const bullets = learnings
		.map((L, i) => {
			const s = String(L.summary || "")
				.replace(/\s+/g, " ")
				.slice(0, 600);
			return `- Case#${i + 1} ${L.caseId || L.supportCaseId}: ${s}`;
		})
		.join("\n");

	const system = `
You are building an internal training memo for a hotel AI receptionist (Jannat Booking).
Summarize recurring patterns across chats, produce a consolidated playbook.
Respect Islamic values; never collect card/CVV in chat; use secure links; keep it concise.
Output JSON ONLY with: combinedSummary (string), topics (string[]), combinedPlaybook (array of {title, steps[], dos[], donts[], exemplar}).
`.trim();

	const user = `
We have ${learnings.length} per‑case summaries:

${bullets}

Tasks:
1) "combinedSummary" ≤ 350 words: intents, best answers, pitfalls, escalation cues.
2) 5–8 "topics" (e.g., Ramadan rates, proximity to Al‑Haram, airport transfer, cancellations).
3) "combinedPlaybook": 3–5 entries with fields: title, steps[], dos[], donts[], exemplar.
Return JSON only.
`.trim();

	const r = await client.chat.completions.create({
		model,
		temperature: 0.4,
		messages: [
			{ role: "system", content: system },
			{ role: "user", content: user },
		],
		max_tokens: 1200,
	});

	const raw = (r.choices?.[0]?.message?.content || "").trim();
	try {
		const parsed = JSON.parse(raw);
		return {
			combinedSummary: String(parsed.combinedSummary || ""),
			topics: Array.isArray(parsed.topics) ? parsed.topics.map(String) : [],
			combinedPlaybook: Array.isArray(parsed.combinedPlaybook)
				? parsed.combinedPlaybook
				: [],
		};
	} catch {
		return { combinedSummary: raw, topics: [], combinedPlaybook: [] };
	}
}

/* ---------------- Controllers ---------------- */

// POST /api/aiagent-learning/build?minMessages=10&limit=150&force=0&mode=single|batch&hotelId=&sortBy=messages|recent&createEmptyBatch=0&dryRun=false
exports.buildFromSupportCases = async (req, res) => {
	try {
		if (!looksLikeOpenAIKey(RAW_KEY)) {
			return res.status(500).json({
				error:
					"OPENAI_API_KEY missing/invalid (must start with 'sk-'). If CHATGPT_API_TOKEN contains a model name, remove it.",
			});
		}
		const MODEL = ANALYSIS_MODEL;

		// Auto-repair indexes/fields up-front
		const indexFixes = await ensureLearningCollectionConsistency();

		const client = new OpenAI({ apiKey: RAW_KEY });
		const hotelId = req.query.hotelId || null;
		const minMessages = Math.max(
			parseInt(req.query.minMessages || "10", 10),
			1
		);
		const limit = Math.min(parseInt(req.query.limit || "150", 10), 500);
		const force = ["1", "true", "yes"].includes(
			String(req.query.force || "0").toLowerCase()
		);
		const mode = String(req.query.mode || "single").toLowerCase(); // 'single' | 'batch'
		const dryRun = String(req.query.dryRun || "false").toLowerCase() === "true";
		const sortBy = String(req.query.sortBy || "messages").toLowerCase(); // 'messages' | 'recent'
		const createEmptyBatch =
			["1", "true", "yes"].includes(
				String(req.query.createEmptyBatch || "0").toLowerCase()
			) && mode === "batch";

		// Choose candidates via aggregation
		const pipeline = [{ $match: { openedBy: "client" } }];
		if (hotelId) {
			try {
				pipeline.push({
					$match: { hotelId: new mongoose.Types.ObjectId(hotelId) },
				});
			} catch {
				pipeline.push({ $match: { hotelId: null } });
			}
		}
		pipeline.push({
			$addFields: {
				messageCount: { $size: { $ifNull: ["$conversation", []] } },
			},
		});
		pipeline.push({ $match: { messageCount: { $gte: minMessages } } });
		if (sortBy === "recent") pipeline.push({ $sort: { createdAt: -1 } });
		else pipeline.push({ $sort: { messageCount: -1, createdAt: -1 } });
		pipeline.push({ $limit: limit });

		const candidates = await SupportCase.aggregate(pipeline);

		let created = 0,
			updated = 0,
			skipped = 0;
		const usedCaseIds = [];
		const usedLearningIds = [];
		const usedLearnings = [];
		const errors = [];

		for (const c of candidates) {
			try {
				const sourceText = (c.conversation || [])
					.map(
						(m) =>
							`${
								m?.messageBy?.customerEmail ||
								m?.messageBy?.customerName ||
								"user"
							}: ${m?.message || ""}`
					)
					.join("\n");
				const sourceHash = stableHash(sourceText);

				const existing = await AiAgentLearning.findOne({
					caseId: c._id,
				}).lean();
				if (existing && !force && existing.sourceHash === sourceHash) {
					skipped++;
					usedCaseIds.push(c._id);
					usedLearningIds.push(existing._id);
					usedLearnings.push(existing);
					continue;
				}

				const analysis = await analyzeOneCase({
					client,
					model: MODEL,
					caseDoc: c,
				});

				if (!dryRun) {
					// Upsert by canonical key: caseId
					const upd = await AiAgentLearning.findOneAndUpdate(
						{ caseId: c._id },
						{
							$set: {
								caseId: c._id,
								supportCaseId: c._id,
								sourceCaseId: c._id, // <-- important for legacy index
								hotelId: c.hotelId || null,
								model: MODEL,
								messageCount: c.messageCount || (c.conversation || []).length,
								sourceHash,
								summary: analysis.summary,
								steps: analysis.steps,
								decisionRules: analysis.decisionRules,
								recommendedResponses: analysis.recommendedResponses,
								commonQuestions: analysis.commonQuestions,
								qualityScore: analysis.qualityScore,
							},
						},
						{ new: true, upsert: true, setDefaultsOnInsert: true }
					);

					if (existing) updated++;
					else created++;

					usedCaseIds.push(c._id);
					usedLearningIds.push(upd._id);
					usedLearnings.push(upd.toObject());
				} else {
					if (existing) updated++;
					else created++;
					usedCaseIds.push(c._id);
					usedLearningIds.push(existing ? existing._id : null);
					usedLearnings.push({ ...analysis, caseId: c._id });
				}
			} catch (e) {
				skipped++;
				errors.push({ caseId: c._id, error: e?.message || "analysis failed" });
			}
		}

		// Optional batch memo
		let batchDoc = null;
		if (mode === "batch" && (usedLearnings.length > 0 || createEmptyBatch)) {
			const combined =
				usedLearnings.length > 0
					? await buildCombinedBatchSummary({
							client,
							model: MODEL,
							learnings: usedLearnings,
					  })
					: { combinedSummary: "", topics: [], combinedPlaybook: [] };

			batchDoc = await AiAgentLearningBatch.create({
				batchKey: `${Date.now()}::min${minMessages}::lim${limit}::sortBy${sortBy}`,
				model: MODEL,
				params: { minMessages, limit, force, sortBy },
				supportCaseIds: usedCaseIds,
				learningIds: usedLearningIds.filter(Boolean),
				counts: {
					candidates: candidates.length,
					created,
					updated,
					skipped,
					totalAnalyzed: usedLearningIds.filter(Boolean).length,
				},
				combinedSummary: combined.combinedSummary,
				combinedPlaybook: combined.combinedPlaybook,
				topics: combined.topics,
			});
		}

		return res.status(200).json({
			ok: true,
			mode,
			model: MODEL,
			keyPreview: maskKey(RAW_KEY),
			indexFixes, // <-- see what was dropped/created/backfilled
			counts: {
				candidates: candidates.length,
				created,
				updated,
				skipped,
				totalAnalyzed: usedLearningIds.filter(Boolean).length,
			},
			batch: batchDoc
				? { id: batchDoc._id, createdAt: batchDoc.createdAt }
				: null,
			errors,
		});
	} catch (err) {
		console.error("[aiagent-learning] build error:", err);
		return res.status(500).json({ error: err?.message || "Internal error" });
	}
};

// GET /api/aiagent-learning/guidance?hotelId=&limit=24
exports.previewGuidance = async (req, res) => {
	try {
		const hotelId = req.query.hotelId || null;
		const limit = Math.min(parseInt(req.query.limit || "24", 10), 64);

		const filter = hotelId ? { hotelId } : {};
		const docs = await AiAgentLearning.find(filter)
			.sort({ updatedAt: -1 })
			.limit(limit)
			.lean();

		const latestBatch = await AiAgentLearningBatch.findOne({})
			.sort({ createdAt: -1 })
			.lean();

		const pick = (arr, max = 16) =>
			Array.from(
				new Set((arr || []).map((s) => String(s).trim()).filter(Boolean))
			).slice(0, max);

		const decisions = pick(
			docs.flatMap((d) => d.decisionRules),
			16
		);
		const recommendations = pick(
			docs.flatMap((d) => d.recommendedResponses),
			16
		);

		const combined = latestBatch
			? {
					summary: String(latestBatch.combinedSummary || ""),
					topics: pick(latestBatch.topics || [], 8),
					playbookTitles: pick(
						(latestBatch.combinedPlaybook || []).map((p) => p.title),
						8
					),
			  }
			: { summary: "", topics: [], playbookTitles: [] };

		return res.json({
			hotelId: hotelId || null,
			samples: docs.length,
			bullets: { decisions, recommendations },
			combined,
		});
	} catch (err) {
		console.error("[aiagent-learning] preview error:", err);
		return res.status(500).json({ error: err?.message || "Internal error" });
	}
};

// DELETE /api/aiagent-learning/clear?hotelId=
exports.clearGuidance = async (req, res) => {
	try {
		const hotelId = req.query.hotelId || null;
		const filter = hotelId ? { hotelId } : {};
		const r = await AiAgentLearning.deleteMany(filter);
		return res.json({ deletedCount: r.deletedCount || 0 });
	} catch (err) {
		console.error("[aiagent-learning] clear error:", err);
		return res.status(500).json({ error: err?.message || "Internal error" });
	}
};

// GET /api/aiagent-learning/selftest
exports.selfTest = async (req, res) => {
	try {
		if (!looksLikeOpenAIKey(RAW_KEY)) {
			return res.status(500).json({
				ok: false,
				error: "OPENAI_API_KEY invalid (must start with sk-)",
			});
		}
		const client = new OpenAI({ apiKey: RAW_KEY });
		const model = ANALYSIS_MODEL;
		const r = await client.chat.completions.create({
			model,
			messages: [{ role: "user", content: "Return the string OK only." }],
			temperature: 0,
			max_tokens: 5,
		});
		const text = (r.choices?.[0]?.message?.content || "").trim();
		return res.json({
			ok: text === "OK",
			model,
			keyPreview: maskKey(RAW_KEY),
			raw: text,
		});
	} catch (e) {
		return res
			.status(500)
			.json({ ok: false, error: e?.message || "OpenAI call failed" });
	}
};
