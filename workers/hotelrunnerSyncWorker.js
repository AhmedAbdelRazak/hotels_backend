/** @format */

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const mongoose = require("mongoose");

// The worker must never let importing the packed Reservations model trigger
// Mongoose's implicit collection/index bootstrap. HotelRunner's own queue
// indexes are created explicitly by ensureHotelRunnerIndexes().
mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);

const safeWorkerErrorMessage = (error) =>
	String(error?.message || "Worker failed")
		.replace(/[\r\n\t]+/g, " ")
		.replace(
			/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi,
			"$1[REDACTED]@"
		)
		.replace(
			/(token|hr_id|authorization|cookie)\s*[=:]\s*[^\s,&]+/gi,
			"$1=[REDACTED]"
		)
		.trim()
		.slice(0, 500);

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
	// Attest the release before loading any reservation worker implementation.
	// This prevents a process from starting out of a tracked, partially deployed
	// checkout and gives the long-running guard an immutable startup identity.
	const {
		assertExactGitRelease,
		createWorkerRevisionGuard,
		heartbeatWorkerRelease,
		inspectGitCheckout,
		markWorkerReleaseStopped,
		registerWorkerRelease,
	} = require("../services/hotelrunnerWorkerRevision");
	const workerRevision = assertExactGitRelease();
	const {
		createHotelRunnerWorker,
	} = require("../services/hotelrunnerWorker");
	const {
		getHotelRunnerConfig,
	} = require("../services/hotelrunnerConfig");
	const {
		ensureHotelRunnerIndexes,
	} = require("../services/hotelrunnerEventService");
	const {
		verifyHotelRunnerReservationIndexes,
	} = require("../services/hotelrunnerReservationIndexReadiness");
	const HotelRunnerSyncState = require("../models/hotelrunner_sync_state");
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
	let shuttingDown = false;
	let shutdownPromise = null;
	let revisionGuard = null;
	const shutdown = (reason, { restart = false } = {}) => {
		if (shutdownPromise) return shutdownPromise;
		shuttingDown = true;
		revisionGuard?.stopScheduling();
		console.log(`[hotelrunner-worker] ${reason} received; shutting down safely.`);
		shutdownPromise = (async () => {
			let stopError = null;
			try {
				// stop() prevents another cycle immediately and resolves only after the
				// active event/pull boundary has completed.
				await worker.stop();
			} catch (error) {
				stopError = error;
			} finally {
				try {
					await markWorkerReleaseStopped({
						SyncStateModel: HotelRunnerSyncState,
						hotelId: config.hotelId,
						instanceId: worker.instanceId,
						revision: workerRevision,
						reason,
					});
				} finally {
					await mongoose.disconnect();
				}
			}
			if (restart) process.exitCode = 75;
			if (stopError) throw stopError;
		})();
		return shutdownPromise;
	};
	await registerWorkerRelease({
		SyncStateModel: HotelRunnerSyncState,
		hotelId: config.hotelId,
		instanceId: worker.instanceId,
		revision: workerRevision,
	});
	revisionGuard = createWorkerRevisionGuard({
		revision: workerRevision,
		inspectCheckout: () => inspectGitCheckout(),
		heartbeat: () =>
			heartbeatWorkerRelease({
				SyncStateModel: HotelRunnerSyncState,
				hotelId: config.hotelId,
				instanceId: worker.instanceId,
				revision: workerRevision,
			}),
		onStopRequired: ({ code }) =>
			shutdown(`revision guard ${code}`, { restart: true }),
	});
	// Recheck after database/index bootstrap. A deployment that moved HEAD while
	// bootstrap was in progress must not get even one event claim.
	try {
		await revisionGuard.checkNow();
		if (shuttingDown) return;
		await worker.start();
	} catch (error) {
		if (!shuttingDown) {
			await markWorkerReleaseStopped({
				SyncStateModel: HotelRunnerSyncState,
				hotelId: config.hotelId,
				instanceId: worker.instanceId,
				revision: workerRevision,
				reason: `startup ${String(error?.code || "failed").slice(0, 80)}`,
			}).catch(() => {});
		}
		throw error;
	}
	revisionGuard.start();
	console.log("[hotelrunner-worker] independent worker started.", {
		releaseSha: workerRevision.releaseSha,
		treeSha: workerRevision.treeSha,
		instanceId: worker.instanceId,
	});
	process.once("SIGINT", () => shutdown("SIGINT").catch(() => (process.exitCode = 1)));
	process.once("SIGTERM", () =>
		shutdown("SIGTERM").catch(() => (process.exitCode = 1))
	);
};

if (require.main === module) {
	main().catch(async (error) => {
		console.error("[hotelrunner-worker] fatal", {
			code: String(error?.code || "HOTELRUNNER_WORKER_FATAL").slice(0, 100),
			message: safeWorkerErrorMessage(error),
		});
		process.exitCode = 1;
		if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
	});
}

module.exports = { assertRoomDiscoveryConfigSafe, main };
