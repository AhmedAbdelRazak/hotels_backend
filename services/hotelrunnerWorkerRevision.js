/** @format */

"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DEFAULT_REPOSITORY_ROOT = path.resolve(__dirname, "..");
const DEFAULT_REVISION_CHECK_INTERVAL_MS = 15 * 1000;
const DEFAULT_WORKER_HEARTBEAT_STALE_MS = 60 * 1000;
const MAX_FUTURE_HEARTBEAT_SKEW_MS = 5 * 60 * 1000;
const GIT_OBJECT_ID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const RUNTIME_SOURCE_ROOTS = Object.freeze([
	"services",
	"models",
	"workers",
	"controllers",
	"routes",
]);
const RUNTIME_LOADABLE_EXTENSIONS = new Set([
	".js",
	".cjs",
	".mjs",
	".json",
	".node",
]);

const revisionError = (code, message) => {
	const error = new Error(message);
	error.code = code;
	return error;
};

const resolvedPath = (value) => {
	const resolved = path.resolve(String(value || ""));
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

function defaultRunGit(args, { repositoryRoot = DEFAULT_REPOSITORY_ROOT } = {}) {
	const result = spawnSync("git", ["-C", repositoryRoot, ...args], {
		encoding: "utf8",
		windowsHide: true,
		timeout: 5_000,
		maxBuffer: 1024 * 1024,
	});
	if (result.error) {
		throw revisionError(
			"HOTELRUNNER_RELEASE_GIT_UNAVAILABLE",
			"Git could not attest the HotelRunner worker release."
		);
	}
	if (result.status !== 0) {
		throw revisionError(
			"HOTELRUNNER_RELEASE_GIT_FAILED",
			"Git could not attest the HotelRunner worker release."
		);
	}
	return String(result.stdout || "").trim();
}

const parseGitPathList = (value = "") => {
	const output = String(value || "");
	return (output.includes("\0") ? output.split("\0") : output.split(/\n/))
		.map((entry) => (entry.endsWith("\r") ? entry.slice(0, -1) : entry))
		.filter((entry) => entry !== "");
};

const isRuntimeLoadableUntrackedPath = (value = "") => {
	const normalized = String(value || "")
		.replace(/\\/g, "/")
		.replace(/^\.\//, "");
	const [root] = normalized.split("/");
	if (!RUNTIME_SOURCE_ROOTS.includes(root)) return false;
	return RUNTIME_LOADABLE_EXTENSIONS.has(
		path.posix.extname(normalized).toLowerCase()
	);
};

const runtimeLoadableUntrackedPaths = (value = "") =>
	parseGitPathList(value).filter(isRuntimeLoadableUntrackedPath);

function readGitCheckout({
	repositoryRoot = DEFAULT_REPOSITORY_ROOT,
	runGit = defaultRunGit,
	now = () => new Date(),
} = {}) {
	const git = (args) => runGit(args, { repositoryRoot });
	const topLevel = git(["rev-parse", "--show-toplevel"]);
	if (resolvedPath(topLevel) !== resolvedPath(repositoryRoot)) {
		throw revisionError(
			"HOTELRUNNER_RELEASE_REPOSITORY_MISMATCH",
			"The HotelRunner worker release was resolved from an unexpected repository."
		);
	}
	const releaseShaBefore = git(["rev-parse", "--verify", "HEAD^{commit}"])
		.toLowerCase();
	const treeSha = git(["rev-parse", "--verify", "HEAD^{tree}"]).toLowerCase();
	const trackedStatusBefore = git([
		"status",
		"--porcelain=v1",
		"--untracked-files=no",
	]);
	const runtimeUntrackedBefore = git([
		"ls-files",
		"--others",
		"-z",
		"--",
		...RUNTIME_SOURCE_ROOTS,
	]);
	const releaseShaAfter = git(["rev-parse", "--verify", "HEAD^{commit}"])
		.toLowerCase();
	const trackedStatusAfter = git([
		"status",
		"--porcelain=v1",
		"--untracked-files=no",
	]);
	const runtimeUntrackedAfter = git([
		"ls-files",
		"--others",
		"-z",
		"--",
		...RUNTIME_SOURCE_ROOTS,
	]);
	if (!GIT_OBJECT_ID.test(releaseShaBefore)) {
		throw revisionError(
			"HOTELRUNNER_RELEASE_HEAD_INVALID",
			"Git returned an invalid HotelRunner worker release identifier."
		);
	}
	if (!GIT_OBJECT_ID.test(treeSha)) {
		throw revisionError(
			"HOTELRUNNER_RELEASE_TREE_INVALID",
			"Git returned an invalid HotelRunner worker release tree identifier."
		);
	}
	if (releaseShaBefore !== releaseShaAfter) {
		throw revisionError(
			"HOTELRUNNER_RELEASE_CHANGED_DURING_ATTESTATION",
			"The HotelRunner worker release changed during startup attestation."
		);
	}
	const observedAt = new Date(now());
	if (!Number.isFinite(observedAt.getTime())) {
		throw revisionError(
			"HOTELRUNNER_RELEASE_CLOCK_INVALID",
			"The HotelRunner worker release timestamp is invalid."
		);
	}
	return {
		valid: true,
		releaseSha: releaseShaBefore,
		treeSha,
		cleanTracked: trackedStatusBefore === "" && trackedStatusAfter === "",
		cleanRuntimeUntracked:
			runtimeLoadableUntrackedPaths(runtimeUntrackedBefore).length === 0 &&
			runtimeLoadableUntrackedPaths(runtimeUntrackedAfter).length === 0,
		observedAt,
	};
}

function inspectGitCheckout(options = {}) {
	try {
		return readGitCheckout(options);
	} catch (error) {
		return {
			valid: false,
			releaseSha: "",
			treeSha: "",
			cleanTracked: false,
			cleanRuntimeUntracked: false,
			observedAt: new Date(),
			errorCode: String(
				error?.code || "HOTELRUNNER_RELEASE_ATTESTATION_FAILED"
			).slice(0, 100),
		};
	}
}

function assertExactGitRelease(options = {}) {
	const checkout = inspectGitCheckout(options);
	if (!checkout.valid) {
		throw revisionError(
			checkout.errorCode || "HOTELRUNNER_RELEASE_ATTESTATION_FAILED",
			"The HotelRunner worker release could not be attested."
		);
	}
	if (checkout.cleanTracked !== true) {
		throw revisionError(
			"HOTELRUNNER_RELEASE_TRACKED_CHECKOUT_DIRTY",
			"The HotelRunner worker requires a clean tracked checkout."
		);
	}
	if (checkout.cleanRuntimeUntracked !== true) {
		throw revisionError(
			"HOTELRUNNER_RELEASE_UNTRACKED_RUNTIME_FILE",
			"The HotelRunner worker release contains an untracked runtime-loadable file."
		);
	}
	return Object.freeze({
		releaseSha: checkout.releaseSha,
		treeSha: checkout.treeSha,
		capturedAt: checkout.observedAt,
	});
}

const BACKEND_STARTUP_REVISION = Object.freeze(
	inspectGitCheckout({ repositoryRoot: DEFAULT_REPOSITORY_ROOT })
);

const getBackendStartupRevision = () => ({ ...BACKEND_STARTUP_REVISION });

const queryResult = async (query) =>
	query && typeof query.exec === "function" ? query.exec() : query;

async function registerWorkerRelease({
	SyncStateModel,
	hotelId,
	instanceId,
	revision,
	now = new Date(),
}) {
	if (!SyncStateModel || !hotelId || !instanceId) {
		throw revisionError(
			"HOTELRUNNER_WORKER_REGISTRATION_INVALID",
			"HotelRunner worker registration is incomplete."
		);
	}
	const startedAt = new Date(now);
	if (
		!revision?.releaseSha ||
		!revision?.treeSha ||
		!Number.isFinite(startedAt.getTime())
	) {
		throw revisionError(
			"HOTELRUNNER_WORKER_REGISTRATION_INVALID",
			"HotelRunner worker registration is incomplete."
		);
	}
	await queryResult(
		SyncStateModel.updateOne(
			{ hotelId },
			{
				$setOnInsert: { hotelId },
				$set: {
					workerReleaseSha: revision.releaseSha,
					workerReleaseTreeSha: revision.treeSha,
					workerInstanceId: instanceId,
					workerStartedAt: startedAt,
					workerHeartbeatAt: startedAt,
				},
				$unset: {
					workerStoppedAt: 1,
					workerStopReason: 1,
				},
			},
			{ upsert: true }
		)
	);
	return startedAt;
}

async function heartbeatWorkerRelease({
	SyncStateModel,
	hotelId,
	instanceId,
	revision,
	now = new Date(),
}) {
	const heartbeatAt = new Date(now);
	const result = await queryResult(
		SyncStateModel.updateOne(
			{
				hotelId,
				workerInstanceId: instanceId,
				workerReleaseSha: revision.releaseSha,
				workerReleaseTreeSha: revision.treeSha,
			},
			{ $set: { workerHeartbeatAt: heartbeatAt } }
		)
	);
	if (Number(result?.matchedCount ?? result?.n ?? 0) !== 1) {
		throw revisionError(
			"HOTELRUNNER_WORKER_REGISTRATION_LOST",
			"HotelRunner worker registration ownership was lost."
		);
	}
	return heartbeatAt;
}

async function markWorkerReleaseStopped({
	SyncStateModel,
	hotelId,
	instanceId,
	revision,
	reason,
	now = new Date(),
}) {
	return queryResult(
		SyncStateModel.updateOne(
			{
				hotelId,
				workerInstanceId: instanceId,
				workerReleaseSha: revision.releaseSha,
				workerReleaseTreeSha: revision.treeSha,
			},
			{
				$set: {
					workerStoppedAt: new Date(now),
					workerStopReason: String(reason || "worker_stopped").slice(0, 100),
				},
			}
		)
	);
}

const revisionMatches = (expected, current) =>
	Boolean(
		current?.valid === true &&
		current?.cleanTracked === true &&
		current?.cleanRuntimeUntracked === true &&
		expected?.releaseSha &&
		expected?.treeSha &&
		expected.releaseSha === current.releaseSha &&
		expected.treeSha === current.treeSha
	);

function createWorkerRevisionGuard({
	revision,
	inspectCheckout = () => inspectGitCheckout(),
	heartbeat = async () => {},
	onStopRequired = async () => {},
	intervalMs = DEFAULT_REVISION_CHECK_INTERVAL_MS,
	setIntervalFn = setInterval,
	clearIntervalFn = clearInterval,
} = {}) {
	let timer = null;
	let checkPromise = null;
	let stopPromise = null;
	let stopRequest = null;

	const requestStop = (request) => {
		if (stopPromise) return stopPromise;
		stopRequest = request;
		if (timer) {
			clearIntervalFn(timer);
			timer = null;
		}
		stopPromise = Promise.resolve().then(() => onStopRequired(request));
		return stopPromise;
	};

	const performCheck = async () => {
		if (stopRequest) {
			await stopPromise;
			return { status: "stop_required", ...stopRequest };
		}
		const current = await inspectCheckout();
		if (!revisionMatches(revision, current)) {
			const code =
				current?.valid !== true
					? current?.errorCode || "HOTELRUNNER_RELEASE_ATTESTATION_FAILED"
					: current?.cleanTracked !== true
					? "HOTELRUNNER_RELEASE_TRACKED_CHECKOUT_DIRTY"
					: current?.cleanRuntimeUntracked !== true
					? "HOTELRUNNER_RELEASE_UNTRACKED_RUNTIME_FILE"
					: "HOTELRUNNER_RELEASE_CHANGED";
			const request = { code, revision, current };
			await requestStop(request);
			return { status: "stop_required", ...request };
		}
		try {
			await heartbeat();
		} catch (error) {
			const request = {
				code: String(
					error?.code || "HOTELRUNNER_WORKER_HEARTBEAT_FAILED"
				).slice(0, 100),
				revision,
				current,
			};
			await requestStop(request);
			return { status: "stop_required", ...request };
		}
		return { status: "healthy", current };
	};

	const checkNow = () => {
		if (checkPromise) return checkPromise;
		checkPromise = performCheck().finally(() => {
			checkPromise = null;
		});
		return checkPromise;
	};

	return {
		checkNow,
		start() {
			if (timer || stopRequest) return;
			timer = setIntervalFn(() => {
				// onStopRequired owns logging and process shutdown. Avoid turning a
				// shutdown-path persistence error into an unhandled rejection.
				void checkNow().catch(() => {});
			}, intervalMs);
			timer?.unref?.();
		},
		stopScheduling() {
			if (timer) clearIntervalFn(timer);
			timer = null;
		},
		async waitForCheck() {
			await checkPromise;
			await stopPromise;
		},
		get stopRequest() {
			return stopRequest;
		},
	};
}

const validDateMs = (value) => {
	if (!value) return Number.NaN;
	const milliseconds = new Date(value).getTime();
	return Number.isFinite(milliseconds) ? milliseconds : Number.NaN;
};

function buildWorkerRevisionHealth({
	config = {},
	syncState = null,
	backendRevision = getBackendStartupRevision(),
	currentCheckout = inspectGitCheckout(),
	now = new Date(),
	heartbeatStaleMs = DEFAULT_WORKER_HEARTBEAT_STALE_MS,
} = {}) {
	const required = Boolean(
		config.projectionEnabled === true ||
		config.pullEnabled === true ||
		config.roomListSyncEnabled === true
	);
	const nowMs = validDateMs(now);
	const heartbeatMs = validDateMs(syncState?.workerHeartbeatAt);
	const startedMs = validDateMs(syncState?.workerStartedAt);
	const stoppedMs = validDateMs(syncState?.workerStoppedAt);
	const heartbeatAgeMs =
		Number.isFinite(nowMs) && Number.isFinite(heartbeatMs)
			? nowMs - heartbeatMs
			: null;
	const alerts = [];
	if (required) {
		if (backendRevision?.valid !== true) alerts.push("backend_revision_unavailable");
		else if (backendRevision.cleanTracked !== true)
			alerts.push("backend_checkout_dirty_at_startup");
		if (
			backendRevision?.valid === true &&
			backendRevision.cleanRuntimeUntracked !== true
		) {
			alerts.push("backend_checkout_untracked_runtime_file");
		}
		if (currentCheckout?.valid !== true)
			alerts.push("current_checkout_revision_unavailable");
		else if (currentCheckout.cleanTracked !== true)
			alerts.push("current_checkout_dirty");
		if (
			currentCheckout?.valid === true &&
			currentCheckout.cleanRuntimeUntracked !== true
		) {
			alerts.push("current_checkout_untracked_runtime_file");
		}
		if (
			!syncState?.workerInstanceId ||
			!syncState?.workerReleaseSha ||
			!syncState?.workerReleaseTreeSha ||
			!Number.isFinite(startedMs) ||
			!Number.isFinite(heartbeatMs)
		) {
			alerts.push("worker_not_registered");
		} else {
			if (Number.isFinite(stoppedMs) && stoppedMs >= startedMs)
				alerts.push("worker_stopped");
			if (
				heartbeatAgeMs > heartbeatStaleMs ||
				heartbeatAgeMs < -MAX_FUTURE_HEARTBEAT_SKEW_MS
			)
				alerts.push("worker_heartbeat_stale");
		}
		if (
			backendRevision?.valid === true &&
			currentCheckout?.valid === true &&
			(backendRevision.releaseSha !== currentCheckout.releaseSha ||
				backendRevision.treeSha !== currentCheckout.treeSha)
		)
			alerts.push("backend_checkout_revision_mismatch");
		if (
			syncState?.workerReleaseSha &&
			backendRevision?.valid === true &&
			(syncState.workerReleaseSha !== backendRevision.releaseSha ||
				syncState.workerReleaseTreeSha !== backendRevision.treeSha)
		)
			alerts.push("worker_backend_revision_mismatch");
		if (
			syncState?.workerReleaseSha &&
			currentCheckout?.valid === true &&
			(syncState.workerReleaseSha !== currentCheckout.releaseSha ||
				syncState.workerReleaseTreeSha !== currentCheckout.treeSha)
		)
			alerts.push("worker_checkout_revision_mismatch");
	}
	const uniqueAlerts = [...new Set(alerts)];
	return {
		required,
		healthy: uniqueAlerts.length === 0,
		status: required
			? uniqueAlerts.length
				? "unhealthy"
				: "healthy"
			: "disabled",
		alerts: uniqueAlerts,
		heartbeatAgeMs,
		heartbeatStaleMs,
		worker: {
			releaseSha: syncState?.workerReleaseSha || null,
			treeSha: syncState?.workerReleaseTreeSha || null,
			instanceId: syncState?.workerInstanceId || null,
			startedAt: syncState?.workerStartedAt || null,
			heartbeatAt: syncState?.workerHeartbeatAt || null,
			stoppedAt: syncState?.workerStoppedAt || null,
			stopReason: syncState?.workerStopReason || null,
		},
		backend: {
			releaseSha: backendRevision?.releaseSha || null,
			treeSha: backendRevision?.treeSha || null,
			capturedAt: backendRevision?.observedAt || null,
			cleanTracked: backendRevision?.cleanTracked === true,
			cleanRuntimeUntracked:
				backendRevision?.cleanRuntimeUntracked === true,
		},
		checkout: {
			releaseSha: currentCheckout?.releaseSha || null,
			treeSha: currentCheckout?.treeSha || null,
			observedAt: currentCheckout?.observedAt || null,
			cleanTracked: currentCheckout?.cleanTracked === true,
			cleanRuntimeUntracked:
				currentCheckout?.cleanRuntimeUntracked === true,
		},
	};
}

module.exports = {
	DEFAULT_REPOSITORY_ROOT,
	DEFAULT_REVISION_CHECK_INTERVAL_MS,
	DEFAULT_WORKER_HEARTBEAT_STALE_MS,
	assertExactGitRelease,
	buildWorkerRevisionHealth,
	createWorkerRevisionGuard,
	defaultRunGit,
	getBackendStartupRevision,
	heartbeatWorkerRelease,
	inspectGitCheckout,
	markWorkerReleaseStopped,
	readGitCheckout,
	registerWorkerRelease,
	revisionMatches,
};
