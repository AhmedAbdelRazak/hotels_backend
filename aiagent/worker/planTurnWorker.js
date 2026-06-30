// Runs one AI support turn outside the main PMS API process.
require("dotenv").config();

process.env.AI_AGENT_WORKER_PROCESS = "true";
process.env.AI_PLAN_USE_WORKER = "false";

const mongoose = require("mongoose");
const { getSupportCaseById } = require("../core/db");
const { __worker } = require("../core/orchestrator");

const silentRoom = {
	emit() {},
};

const silentIo = {
	__aiWorkerNoDirectEmit: true,
	to() {
		return silentRoom;
	},
	emit() {},
	on() {},
};

async function main() {
	const caseId = String(process.argv[2] || "").trim();
	if (!caseId) {
		throw new Error("Missing support case id");
	}
	const database =
		process.env.DATABASE || process.env.MONGO_URI || process.env.MONGODB_URI;
	if (!database) {
		throw new Error("Missing DATABASE connection string");
	}
	if (!__worker || typeof __worker.planTurn !== "function") {
		throw new Error("AI planTurn worker export is not available");
	}

	mongoose.set("strictQuery", false);
	await mongoose.connect(database, {
		useNewUrlParser: true,
		useUnifiedTopology: true,
	});

	const supportCase = await getSupportCaseById(caseId);
	if (!supportCase) {
		throw new Error(`Support case not found: ${caseId}`);
	}
	await __worker.planTurn(silentIo, supportCase);
}

main()
	.catch((error) => {
		console.error("[aiagent-worker] plan turn failed:", error?.stack || error);
		process.exitCode = 1;
	})
	.finally(async () => {
		try {
			await mongoose.disconnect();
		} catch {
			// Best effort; process exit will release the connection.
		}
	});
