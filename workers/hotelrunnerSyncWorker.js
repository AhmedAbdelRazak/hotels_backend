/** @format */

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const mongoose = require("mongoose");
const {
	createHotelRunnerWorker,
} = require("../services/hotelrunnerWorker");
const {
	ensureHotelRunnerIndexes,
	safeErrorMessage,
} = require("../services/hotelrunnerEventService");

const main = async () => {
	if (!process.env.DATABASE) throw new Error("DATABASE is not configured");
	mongoose.set("strictQuery", false);
	await mongoose.connect(process.env.DATABASE, {
		useNewUrlParser: true,
		useUnifiedTopology: true,
	});
	await ensureHotelRunnerIndexes();
	const worker = createHotelRunnerWorker();
	if (process.argv.includes("--once")) {
		const pullResult = await worker.runPullIfDue();
		const processed = await worker.runUntilIdle({ maxCycles: 1_000 });
		console.log(
			`[hotelrunner-worker] one-shot pull ${pullResult.status}; processed ${processed} event(s).`
		);
		await mongoose.disconnect();
		return;
	}
	await worker.start();
	console.log("[hotelrunner-worker] independent worker started.");
	let shuttingDown = false;
	const shutdown = async (signal) => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.log(`[hotelrunner-worker] ${signal} received; shutting down safely.`);
		try {
			await worker.stop();
		} finally {
			await mongoose.disconnect();
		}
	};
	process.once("SIGINT", () => shutdown("SIGINT").catch(() => (process.exitCode = 1)));
	process.once("SIGTERM", () =>
		shutdown("SIGTERM").catch(() => (process.exitCode = 1))
	);
};

if (require.main === module) {
	main().catch(async (error) => {
		console.error("[hotelrunner-worker] fatal", {
			code: String(error?.code || "HOTELRUNNER_WORKER_FATAL").slice(0, 100),
			message: safeErrorMessage(error, "Worker failed"),
		});
		process.exitCode = 1;
		if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
	});
}

module.exports = { main };
