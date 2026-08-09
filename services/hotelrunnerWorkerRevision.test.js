/** @format */

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
	assertExactGitRelease,
	buildWorkerRevisionHealth,
	createWorkerRevisionGuard,
	heartbeatWorkerRelease,
	registerWorkerRelease,
} = require("./hotelrunnerWorkerRevision");

const RELEASE_A = "a".repeat(40);
const RELEASE_B = "b".repeat(40);
const TREE_A = "c".repeat(40);
const TREE_B = "d".repeat(40);
const REPOSITORY_ROOT = "/srv/xhotelpro/hotels_backend";

const gitFixture = ({
	headBefore = RELEASE_A,
	headAfter = headBefore,
	tree = TREE_A,
	statusBefore = "",
	statusAfter = statusBefore,
	runtimeUntrackedBefore = "",
	runtimeUntrackedAfter = runtimeUntrackedBefore,
} = {}) => {
	let statusReads = 0;
	let headReads = 0;
	let runtimeUntrackedReads = 0;
	return (args) => {
		const command = args.join(" ");
		if (command === "rev-parse --show-toplevel") return REPOSITORY_ROOT;
		if (command === "rev-parse --verify HEAD^{commit}")
			return headReads++ === 0 ? headBefore : headAfter;
		if (command === "rev-parse --verify HEAD^{tree}") return tree;
		if (command === "status --porcelain=v1 --untracked-files=no")
			return statusReads++ === 0 ? statusBefore : statusAfter;
		if (
			command ===
			"ls-files --others -z -- services models workers controllers routes"
		) {
			return runtimeUntrackedReads++ === 0
				? runtimeUntrackedBefore
				: runtimeUntrackedAfter;
		}
		assert.fail(`unexpected git command: ${command}`);
	};
};

const nulPaths = (...paths) => (paths.length ? `${paths.join("\0")}\0` : "");

test("worker startup release attestation accepts one exact clean HEAD and tree", () => {
	const capturedAt = new Date("2026-08-09T16:00:00.000Z");
	const revision = assertExactGitRelease({
		repositoryRoot: REPOSITORY_ROOT,
		runGit: gitFixture(),
		now: () => capturedAt,
	});
	assert.deepEqual(revision, {
		releaseSha: RELEASE_A,
		treeSha: TREE_A,
		capturedAt,
	});
	assert.equal(Object.isFrozen(revision), true);
});

test("dirty, unresolved, and moving tracked checkouts fail closed", () => {
	for (const [name, fixture, code] of [
		[
			"tracked modification",
			{ statusBefore: " M services/hotelrunnerWorker.js" },
			"HOTELRUNNER_RELEASE_TRACKED_CHECKOUT_DIRTY",
		],
		[
			"unresolved merge",
			{ statusBefore: "UU workers/hotelrunnerSyncWorker.js" },
			"HOTELRUNNER_RELEASE_TRACKED_CHECKOUT_DIRTY",
		],
		[
			"HEAD movement",
			{ headAfter: RELEASE_B },
			"HOTELRUNNER_RELEASE_CHANGED_DURING_ATTESTATION",
		],
	]) {
		assert.throws(
			() =>
				assertExactGitRelease({
					repositoryRoot: REPOSITORY_ROOT,
					runGit: gitFixture(fixture),
				}),
			(error) => error?.code === code,
			name
		);
	}
});

test("untracked runtime-loadable files in backend code roots fail startup attestation", () => {
	for (const file of [
		"services/injected.js",
		"models/injected.cjs",
		"workers/injected.mjs",
		"controllers/injected.json",
		"routes/injected.node",
		"services/UPPERCASE.JS",
	]) {
		assert.throws(
			() =>
				assertExactGitRelease({
					repositoryRoot: REPOSITORY_ROOT,
					runGit: gitFixture({
						runtimeUntrackedBefore: nulPaths(file),
					}),
				}),
			(error) =>
				error?.code === "HOTELRUNNER_RELEASE_UNTRACKED_RUNTIME_FILE",
			file
		);
	}
});

test("a runtime-loadable file appearing during attestation also fails closed", () => {
	assert.throws(
		() =>
			assertExactGitRelease({
				repositoryRoot: REPOSITORY_ROOT,
				runGit: gitFixture({
					runtimeUntrackedBefore: "",
					runtimeUntrackedAfter: nulPaths("services/late-loader.json"),
				}),
			}),
		(error) => error?.code === "HOTELRUNNER_RELEASE_UNTRACKED_RUNTIME_FILE"
	);
});

test("deployment backups and non-runtime untracked files do not dirty release attestation", () => {
	const capturedAt = new Date("2026-08-09T16:05:00.000Z");
	const revision = assertExactGitRelease({
		repositoryRoot: REPOSITORY_ROOT,
		runGit: gitFixture({
			runtimeUntrackedBefore: nulPaths(
				"services/hotelrunnerWorker.js.bak-20260809T160000Z",
				"models/reservations.js.bak-manual",
				"workers/notes.txt",
				"controllers/config.json.bak-1",
				"routes/native.node.disabled"
			),
		}),
		now: () => capturedAt,
	});
	assert.equal(revision.releaseSha, RELEASE_A);
	assert.equal(revision.treeSha, TREE_A);
	assert.equal(revision.capturedAt.toISOString(), capturedAt.toISOString());
});

test("a HEAD change requests shutdown and waits for the active boundary", async () => {
	let releaseBoundary;
	const boundary = new Promise((resolve) => {
		releaseBoundary = resolve;
	});
	let stopRequested = false;
	let shutdownCompleted = false;
	const guard = createWorkerRevisionGuard({
		revision: { releaseSha: RELEASE_A, treeSha: TREE_A },
		inspectCheckout: async () => ({
			valid: true,
			cleanTracked: true,
			cleanRuntimeUntracked: true,
			releaseSha: RELEASE_B,
			treeSha: TREE_B,
		}),
		heartbeat: async () => assert.fail("mismatched release must not heartbeat"),
		onStopRequired: async ({ code }) => {
			assert.equal(code, "HOTELRUNNER_RELEASE_CHANGED");
			stopRequested = true;
			await boundary;
			shutdownCompleted = true;
		},
	});

	const check = guard.checkNow();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(stopRequested, true);
	assert.equal(shutdownCompleted, false);
	releaseBoundary();
	const result = await check;
	assert.equal(result.status, "stop_required");
	assert.equal(shutdownCompleted, true);
});

test("worker release registration and heartbeat are identity-bound", async () => {
	const writes = [];
	let heartbeatMatches = 1;
	const SyncStateModel = {
		updateOne(filter, update, options) {
			writes.push({ filter, update, options });
			return { exec: async () => ({ matchedCount: heartbeatMatches }) };
		},
	};
	const revision = { releaseSha: RELEASE_A, treeSha: TREE_A };
	const startedAt = new Date("2026-08-09T16:00:00.000Z");
	const heartbeatAt = new Date("2026-08-09T16:00:15.000Z");
	await registerWorkerRelease({
		SyncStateModel,
		hotelId: "hotel-1",
		instanceId: "worker-1",
		revision,
		now: startedAt,
	});
	await heartbeatWorkerRelease({
		SyncStateModel,
		hotelId: "hotel-1",
		instanceId: "worker-1",
		revision,
		now: heartbeatAt,
	});
	assert.equal(writes[0].update.$set.workerReleaseSha, RELEASE_A);
	assert.equal(writes[0].update.$set.workerReleaseTreeSha, TREE_A);
	assert.equal(
		writes[0].update.$set.workerStartedAt.toISOString(),
		startedAt.toISOString()
	);
	assert.equal(writes[1].filter.workerInstanceId, "worker-1");
	assert.equal(writes[1].filter.workerReleaseSha, RELEASE_A);
	assert.equal(
		writes[1].update.$set.workerHeartbeatAt.toISOString(),
		heartbeatAt.toISOString()
	);

	heartbeatMatches = 0;
	await assert.rejects(
		heartbeatWorkerRelease({
			SyncStateModel,
			hotelId: "hotel-1",
			instanceId: "superseded-worker",
			revision,
			now: heartbeatAt,
		}),
		(error) => error?.code === "HOTELRUNNER_WORKER_REGISTRATION_LOST"
	);
});

test("revision health requires worker, backend, and checkout parity plus a fresh heartbeat", () => {
	const now = new Date("2026-08-09T16:01:00.000Z");
	const base = {
		config: { projectionEnabled: true },
		now,
		backendRevision: {
			valid: true,
			cleanTracked: true,
			cleanRuntimeUntracked: true,
			releaseSha: RELEASE_A,
			treeSha: TREE_A,
			observedAt: new Date("2026-08-09T16:00:00.000Z"),
		},
		currentCheckout: {
			valid: true,
			cleanTracked: true,
			cleanRuntimeUntracked: true,
			releaseSha: RELEASE_A,
			treeSha: TREE_A,
			observedAt: now,
		},
		syncState: {
			workerReleaseSha: RELEASE_A,
			workerReleaseTreeSha: TREE_A,
			workerInstanceId: "worker-1",
			workerStartedAt: new Date("2026-08-09T16:00:00.000Z"),
			workerHeartbeatAt: new Date("2026-08-09T16:00:45.000Z"),
		},
	};
	const healthy = buildWorkerRevisionHealth(base);
	assert.equal(healthy.status, "healthy");
	assert.equal(healthy.healthy, true);
	assert.deepEqual(healthy.alerts, []);
	assert.equal(healthy.heartbeatAgeMs, 15_000);

	const mismatched = buildWorkerRevisionHealth({
		...base,
		syncState: {
			...base.syncState,
			workerReleaseSha: RELEASE_B,
			workerReleaseTreeSha: TREE_B,
		},
	});
	assert.equal(mismatched.healthy, false);
	assert.equal(
		mismatched.alerts.includes("worker_backend_revision_mismatch"),
		true
	);
	assert.equal(
		mismatched.alerts.includes("worker_checkout_revision_mismatch"),
		true
	);

	const stale = buildWorkerRevisionHealth({
		...base,
		syncState: {
			...base.syncState,
			workerHeartbeatAt: new Date("2026-08-09T15:59:00.000Z"),
		},
	});
	assert.equal(stale.healthy, false);
	assert.equal(stale.alerts.includes("worker_heartbeat_stale"), true);

	const untrackedRuntime = buildWorkerRevisionHealth({
		...base,
		currentCheckout: {
			...base.currentCheckout,
			cleanRuntimeUntracked: false,
		},
	});
	assert.equal(untrackedRuntime.healthy, false);
	assert.equal(
		untrackedRuntime.alerts.includes(
			"current_checkout_untracked_runtime_file"
		),
		true
	);

	const disabled = buildWorkerRevisionHealth({
		config: {
			projectionEnabled: false,
			pullEnabled: false,
			roomListSyncEnabled: false,
		},
		backendRevision: { valid: false },
		currentCheckout: { valid: false },
		syncState: null,
		now,
	});
	assert.equal(disabled.status, "disabled");
	assert.equal(disabled.healthy, true);
});
