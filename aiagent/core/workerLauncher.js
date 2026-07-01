const path = require("path");
const { spawn } = require("child_process");
const SupportCase = require("../../models/supportcase");

function intFromEnv(name, fallback, { min = 0, max = 60000 } = {}) {
	const parsed = parseInt(process.env[name] || "", 10);
	const value = Number.isFinite(parsed) ? parsed : fallback;
	return Math.min(max, Math.max(min, value));
}

const AI_PLAN_WORKER_TIMEOUT_MS = intFromEnv("AI_PLAN_WORKER_TIMEOUT_MS", 30000, {
	min: 10000,
	max: 120000,
});
const AI_PLAN_WORKER_HEAP_MB = intFromEnv("AI_PLAN_WORKER_HEAP_MB", 1024, {
	min: 128,
	max: 1024,
});

function caseIdText(value = "") {
	return String(value?._id || value || "").trim();
}

async function loadCaseForWorkerLaunch(caseId = "") {
	if (!caseId) return null;
	return SupportCase.findById(caseId)
		.select("_id caseStatus aiToRespond aiResponderName")
		.lean()
		.exec()
		.catch(() => null);
}

function emitAiTyping(io, supportCase = {}, isTyping = true) {
	const caseId = caseIdText(supportCase);
	if (!io || !caseId) return;
	io.to(caseId).emit(isTyping ? "typing" : "stopTyping", {
		caseId,
		name: supportCase.aiResponderName || "Reception",
		isAi: true,
	});
}

function spawnWorker(caseId = "") {
	const workerPath = path.join(__dirname, "../worker/planTurnWorker.js");
	const child = spawn(
		process.execPath,
		[`--max-old-space-size=${AI_PLAN_WORKER_HEAP_MB}`, workerPath, caseId],
		{
			cwd: path.join(__dirname, "../.."),
			env: {
				...process.env,
				AI_AGENT_WORKER_PROCESS: "true",
				AI_PLAN_USE_WORKER: "false",
				OPENAI_CHATBOT_MAX_PROMPT_CHARS:
					process.env.OPENAI_CHATBOT_MAX_PROMPT_CHARS || "8000",
			},
			stdio: ["ignore", "ignore", "ignore"],
			detached: false,
		}
	);
	child.unref?.();
	return child;
}

function launchAiPlanWorker(io, supportCaseOrId, { delayMs = 75 } = {}) {
	const caseId = caseIdText(supportCaseOrId);
	if (!caseId || !io) return;
	const delay = Math.max(0, Number(delayMs) || 0);
	const timer = setTimeout(async () => {
		const supportCase = await loadCaseForWorkerLaunch(caseId);
		if (
			!supportCase ||
			supportCase.caseStatus === "closed" ||
			supportCase.aiToRespond === false
		) {
			return;
		}
		emitAiTyping(io, supportCase, true);
		let child = null;
		try {
			child = spawnWorker(caseId);
			console.log("[aiagent] detached worker launched", {
				caseId,
				pid: child.pid,
			});
		} catch (error) {
			console.error("[aiagent] worker launch failed:", error?.message || error);
			emitAiTyping(io, supportCase, false);
			return;
		}
		const cleanupTimer = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {
				// Process may already be gone.
			}
			emitAiTyping(io, supportCase, false);
		}, AI_PLAN_WORKER_TIMEOUT_MS + 1500);
		cleanupTimer.unref?.();
		child.once("exit", (code, signal) => {
			clearTimeout(cleanupTimer);
			console.log("[aiagent] detached worker exited", {
				caseId,
				code,
				signal,
			});
			if (code !== 0 || signal) {
				console.error("[aiagent] detached worker failed", {
					caseId,
					code,
					signal,
				});
			}
			emitAiTyping(io, supportCase, false);
		});
		child.once("error", (error) => {
			clearTimeout(cleanupTimer);
			console.error("[aiagent] detached worker error:", error?.message || error);
			emitAiTyping(io, supportCase, false);
		});
	}, delay);
	timer.unref?.();
}

module.exports = {
	launchAiPlanWorker,
};
