/** @format */

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const {
	assertRoomDiscoveryConfigSafe,
} = require("../workers/hotelrunnerSyncWorker");

const closedConfig = () => ({
	projectionEnabled: false,
	pullEnabled: false,
	roomListSyncEnabled: false,
	confirmDeliveryEnabled: false,
});

test("room-list-only bootstrap accepts only a fully closed effective gate set", () => {
	assert.equal(assertRoomDiscoveryConfigSafe(closedConfig()), true);

	for (const [property, key] of [
		["projectionEnabled", "HOTELRUNNER_PROJECTION_ENABLED"],
		["pullEnabled", "HOTELRUNNER_PULL_ENABLED"],
		["roomListSyncEnabled", "HOTELRUNNER_ROOM_LIST_SYNC_ENABLED"],
		["confirmDeliveryEnabled", "HOTELRUNNER_CONFIRM_DELIVERY_ENABLED"],
	]) {
		assert.throws(
			() =>
				assertRoomDiscoveryConfigSafe({
					...closedConfig(),
					[property]: true,
				}),
			(error) => {
				assert.equal(error.code, "HOTELRUNNER_ROOM_DISCOVERY_GATE_OPEN");
				assert.deepEqual(error.openGates, [key]);
				assert.equal(error.message.includes(key), true);
				return true;
			}
		);
	}
});

test("room-list-only bootstrap reports every open gate by name", () => {
	assert.throws(
		() =>
			assertRoomDiscoveryConfigSafe({
				projectionEnabled: true,
				pullEnabled: true,
				roomListSyncEnabled: true,
				confirmDeliveryEnabled: true,
			}),
		(error) => {
			assert.equal(error.code, "HOTELRUNNER_ROOM_DISCOVERY_GATE_OPEN");
			assert.equal(error.openGates.length, 4);
			return true;
		}
	);
});

test("worker and reservation-index verifier disable implicit Mongoose writes before model imports", () => {
	for (const entrypoint of [
		require.resolve("../workers/hotelrunnerSyncWorker"),
		require.resolve("../scripts/verifyHotelRunnerReservationIndexes"),
	]) {
		const source = fs.readFileSync(entrypoint, "utf8");
		const firstServiceImport = source.indexOf('require("../services/');
		const autoIndexDisable = source.indexOf('mongoose.set("autoIndex", false)');
		const autoCreateDisable = source.indexOf('mongoose.set("autoCreate", false)');
		const connectCall = source.indexOf("mongoose.connect(");

		assert.notEqual(firstServiceImport, -1, entrypoint);
		assert.ok(autoIndexDisable > -1 && autoIndexDisable < firstServiceImport, entrypoint);
		assert.ok(autoCreateDisable > -1 && autoCreateDisable < firstServiceImport, entrypoint);
		assert.ok(autoIndexDisable < connectCall, entrypoint);
		assert.ok(autoCreateDisable < connectCall, entrypoint);
		assert.match(source, /mongoose\.connect\([\s\S]*?autoIndex:\s*false/);
		assert.match(source, /mongoose\.connect\([\s\S]*?autoCreate:\s*false/);
		assert.doesNotMatch(
			source,
			/Reservations\.(?:init|createIndexes|syncIndexes)\s*\(/
		);
	}
});

test("daemon attests a clean exact release before loading reservation worker code", () => {
	const entrypoint = require.resolve("../workers/hotelrunnerSyncWorker");
	const source = fs.readFileSync(entrypoint, "utf8");
	const attestation = source.indexOf(
		"const workerRevision = assertExactGitRelease();"
	);
	const workerImplementation = source.indexOf(
		'require("../services/hotelrunnerWorker")'
	);
	const registration = source.indexOf("await registerWorkerRelease({");
	const workerStart = source.indexOf("await worker.start();");

	assert.ok(attestation > -1 && attestation < workerImplementation);
	assert.ok(registration > workerImplementation && registration < workerStart);
	assert.match(source, /await revisionGuard\.checkNow\(\);[\s\S]*await worker\.start\(\)/);
});

test("master-disabled branch precedes every worker database connection", () => {
	const entrypoint = require.resolve("../workers/hotelrunnerSyncWorker");
	const source = fs.readFileSync(entrypoint, "utf8");
	const disabledBoundary = source.indexOf("config.integrationEnabled !== true");
	const modelImport = source.indexOf(
		'require("../models/hotelrunner_sync_state")'
	);
	const connectCall = source.indexOf("mongoose.connect(");
	const clientImport = source.indexOf('require("../services/hotelrunnerWorker")');
	assert.ok(disabledBoundary > -1 && disabledBoundary < modelImport);
	assert.ok(disabledBoundary < clientImport);
	assert.ok(disabledBoundary < connectCall);
});

const runDisabledWorker = ({ args = [], expectLongRunning = false } = {}) =>
	new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[path.join(__dirname, "../workers/hotelrunnerSyncWorker.js"), ...args],
			{
				cwd: path.join(__dirname, ".."),
				env: {
					...process.env,
					HOTELRUNNER_INTEGRATION_ENABLED: "false",
					DATABASE: "mongodb://invalid.example.invalid/never-connect",
				},
				stdio: ["ignore", "pipe", "pipe"],
			}
		);
		let output = "";
		let settled = false;
		let idleObserved = false;
		let terminationRequested = false;
		let terminationTimer = null;
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			if (terminationTimer) clearTimeout(terminationTimer);
			child.kill("SIGKILL");
			reject(new Error("disabled worker subprocess did not settle safely"));
		}, 5000);
		child.stdout.on("data", (chunk) => {
			output += chunk.toString();
			if (
				expectLongRunning &&
				output.includes("idle guard active") &&
				child.exitCode === null &&
				!idleObserved
			) {
				idleObserved = true;
				terminationTimer = setTimeout(() => {
					if (settled || child.exitCode !== null) return;
					terminationRequested = true;
					child.kill("SIGTERM");
				}, 750);
			}
		});
		child.stderr.on("data", (chunk) => {
			output += chunk.toString();
		});
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (terminationTimer) clearTimeout(terminationTimer);
			reject(error);
		});
		child.once("exit", (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (terminationTimer) clearTimeout(terminationTimer);
			if (expectLongRunning && !terminationRequested) {
				reject(
					new Error(
						`disabled worker exited before the inert dwell proof: ${JSON.stringify({
							code,
							signal,
							idleObserved,
							output,
						})}`
					)
				);
				return;
			}
			resolve({ code, signal, output });
		});
	});

test("master-disabled daemon stays inert until SIGTERM and never connects", async () => {
	const result = await runDisabledWorker({ expectLongRunning: true });
	assert.ok(
		result.code === 0 || result.signal === "SIGTERM",
		`unexpected disabled-worker exit: ${JSON.stringify(result)}`
	);
	assert.match(result.output, /idle guard active with no database or vendor access/);
	assert.doesNotMatch(result.output, /ENOTFOUND|ECONN|fatal|independent worker started/);
});

test("master-disabled one-shot command exits without database or vendor access", async () => {
	const result = await runDisabledWorker({ args: ["--once"] });
	assert.equal(result.code, 0);
	assert.equal(result.signal, null);
	assert.match(result.output, /idle guard active with no database or vendor access/);
	assert.doesNotMatch(result.output, /ENOTFOUND|ECONN|fatal|independent worker started/);
});
