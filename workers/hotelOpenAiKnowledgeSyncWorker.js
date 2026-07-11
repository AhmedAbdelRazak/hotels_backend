/** @format */

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const mongoose = require("mongoose");
const {
	createHotelOpenAiKnowledgeSyncWorker,
} = require("../services/hotelOpenAiKnowledgeSyncWorker");

const main = async () => {
	if (!process.env.DATABASE) throw new Error("DATABASE is not configured");
	if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");

	mongoose.set("strictQuery", false);
	await mongoose.connect(process.env.DATABASE, {
		useNewUrlParser: true,
		useUnifiedTopology: true,
	});

	const worker = createHotelOpenAiKnowledgeSyncWorker();
	const once = process.argv.includes("--once");
	if (once) {
		await worker.reconcile("manual_once_reconciliation");
		const processed = await worker.runUntilIdle({ maxCycles: 1000 });
		console.log(`[hotel-openai-sync] one-shot run processed ${processed} job(s).`);
		await mongoose.disconnect();
		return;
	}

	await worker.start();
	console.log("[hotel-openai-sync] independent worker started.");

	let shuttingDown = false;
	const shutdown = async (signal) => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.log(`[hotel-openai-sync] ${signal} received; shutting down safely.`);
		try {
			await worker.stop();
		} finally {
			await mongoose.disconnect();
		}
	};

	process.once("SIGINT", () => {
		shutdown("SIGINT").catch((error) => {
			console.error("[hotel-openai-sync] shutdown failed:", error?.message || error);
			process.exitCode = 1;
		});
	});
	process.once("SIGTERM", () => {
		shutdown("SIGTERM").catch((error) => {
			console.error("[hotel-openai-sync] shutdown failed:", error?.message || error);
			process.exitCode = 1;
		});
	});
};

if (require.main === module) {
	main().catch(async (error) => {
		console.error("[hotel-openai-sync] fatal:", error?.message || error);
		process.exitCode = 1;
		if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
	});
}

module.exports = { main };
