/** @format */

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const mongoose = require("mongoose");

// The worker must never let importing the packed Reservations model trigger
// Mongoose's implicit collection/index bootstrap. HotelRunner's own queue
// indexes are created explicitly by ensureHotelRunnerIndexes().
mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);

const {
	createHotelRunnerWorker,
} = require("../services/hotelrunnerWorker");
const {
	getHotelRunnerConfig,
} = require("../services/hotelrunnerConfig");
const {
	ensureHotelRunnerIndexes,
	safeErrorMessage,
} = require("../services/hotelrunnerEventService");
const {
	verifyHotelRunnerReservationIndexes,
} = require("../services/hotelrunnerReservationIndexReadiness");

const assertRoomDiscoveryConfigSafe = (config = {}) => {
	const openGates = [
		["HOTELRUNNER_PROJECTION_ENABLED", config.projectionEnabled],
		["HOTELRUNNER_PULL_ENABLED", config.pullEnabled],
		["HOTELRUNNER_ROOM_LIST_SYNC_ENABLED", config.roomListSyncEnabled],
		["HOTELRUNNER_CONFIRM_DELIVERY_ENABLED", config.confirmDeliveryEnabled],
	]
		.filter(([, enabled]) => enabled === true)
		.map(([key]) => key);
	if (!openGates.length) return true;
	const error = new Error(
		`Room-list discovery requires closed HotelRunner gates: ${openGates.join(", ")}.`
	);
	error.code = "HOTELRUNNER_ROOM_DISCOVERY_GATE_OPEN";
	error.openGates = openGates;
	throw error;
};

const main = async () => {
	const config = getHotelRunnerConfig();
	if (!config.configured) {
		const error = new Error("HotelRunner worker configuration is incomplete.");
		error.code = "HOTELRUNNER_CONFIG_INVALID";
		throw error;
	}
	const roomDiscoveryOnly = process.argv.includes("--rooms-only");
	if (roomDiscoveryOnly) assertRoomDiscoveryConfigSafe(config);
	if (!process.env.DATABASE) throw new Error("DATABASE is not configured");
	mongoose.set("strictQuery", false);
	await mongoose.connect(process.env.DATABASE, {
		useNewUrlParser: true,
		useUnifiedTopology: true,
		autoIndex: false,
		autoCreate: false,
	});
	await ensureHotelRunnerIndexes();
	// Read-only fail-closed proof for the two business-identity indexes that
	// serialize OTA-email and HotelRunner creates. Never auto-create indexes on
	// the packed Reservations collection from this worker.
	await verifyHotelRunnerReservationIndexes();
	const worker = createHotelRunnerWorker({ config });
	if (roomDiscoveryOnly) {
		const result = await worker.runRoomListOnly();
		console.log(
			`[hotelrunner-worker] room-list discovery ${result.status}; ` +
				`${Number(result.roomMappingsSeen || 0)} inventory code(s); ` +
				`${Number(result.apiCalls || 0)} API call(s).`
		);
		await mongoose.disconnect();
		return;
	}
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

module.exports = { assertRoomDiscoveryConfigSafe, main };
