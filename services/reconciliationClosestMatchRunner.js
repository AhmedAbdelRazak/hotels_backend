/** @format */

"use strict";

const { performance } = require("perf_hooks");
const { Worker } = require("worker_threads");
const {
	HARD_MAX_CANDIDATES,
	MAX_TARGET_CENTS,
	ReconciliationClosestMatchError,
} = require("./reconciliationClosestMatch");

const DEFAULT_TIMEOUT_MS = 5000;
const HARD_TIMEOUT_MS = 15000;

const timeoutValue = (value) => {
	if (value === undefined || value === null || value === "") {
		return DEFAULT_TIMEOUT_MS;
	}
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS;
	return Math.min(Math.max(Math.floor(parsed), 0), HARD_TIMEOUT_MS);
};

const safeWorkerOptions = (options = {}) => ({
	maxCandidates: options.maxCandidates,
	maxSelectedCount: options.maxSelectedCount ?? options.maxSelected,
	maxBitStates: options.maxBitStates,
	polishPoolSize: options.polishPoolSize,
});

const preflightError = (candidates, targetCents) => {
	if (!Array.isArray(candidates)) {
		return new ReconciliationClosestMatchError(
			"candidates must be an array",
			"invalid_closest_match_candidates"
		);
	}
	if (candidates.length > HARD_MAX_CANDIDATES) {
		return new ReconciliationClosestMatchError(
			`At most ${HARD_MAX_CANDIDATES} reconciliation candidates can be matched at once`,
			"closest_match_candidate_limit_exceeded",
			422
		);
	}
	const invalidIndex = candidates.findIndex(
		(candidate) =>
			!candidate || typeof candidate !== "object" || Array.isArray(candidate)
	);
	if (invalidIndex >= 0) {
		return new ReconciliationClosestMatchError(
			`Candidate ${invalidIndex + 1} must be an object`,
			"invalid_closest_match_candidate"
		);
	}
	if (
		!Number.isSafeInteger(targetCents) ||
		targetCents <= 0 ||
		targetCents > MAX_TARGET_CENTS
	) {
		return new ReconciliationClosestMatchError(
			`targetCents must be a positive safe integer no greater than ${MAX_TARGET_CENTS}`,
			"invalid_closest_match_target"
		);
	}
	return null;
};

const timeoutError = (elapsedMs) => {
	const error = new ReconciliationClosestMatchError(
		"Closest reconciliation matching timed out; narrow the selected range and try again",
		"closest_match_timeout",
		503
	);
	error.elapsedMs = elapsedMs;
	return error;
};

const runClosestReconciliationMatch = (
	candidates,
	targetCents,
	options = {}
) => {
	const startedAt = performance.now();
	const invalid = preflightError(candidates, targetCents);
	if (invalid) return Promise.reject(invalid);
	const timeoutMs = timeoutValue(options.timeoutMs);
	if (timeoutMs === 0) {
		return Promise.reject(timeoutError(0));
	}
	return new Promise((resolve, reject) => {
		let settled = false;
		const worker = new Worker(
			require.resolve("./reconciliationClosestMatchWorker"),
			{
				workerData: {
					candidates,
					targetCents,
					options: safeWorkerOptions(options),
				},
				resourceLimits: {
					maxOldGenerationSizeMb: 160,
					maxYoungGenerationSizeMb: 32,
					stackSizeMb: 4,
				},
			}
		);
		const finish = (callback) => {
			if (settled) return false;
			settled = true;
			clearTimeout(timer);
			callback();
			return true;
		};
		const timer = setTimeout(() => {
			finish(() => {
				const elapsedMs = Number((performance.now() - startedAt).toFixed(3));
				void worker.terminate();
				reject(timeoutError(elapsedMs));
			});
		}, timeoutMs);
		worker.once("message", (message) => {
			finish(() => {
				if (message?.ok) {
					resolve({ ...message.result, timedOut: false });
					return;
				}
				const payload = message?.error || {};
				const error = new ReconciliationClosestMatchError(
					payload.message || "Closest-match worker failed",
					payload.code || "closest_match_worker_failed",
					Number(payload.statusCode) || 500
				);
				error.name = payload.name || error.name;
				reject(error);
			});
		});
		worker.once("error", (error) => {
			finish(() => reject(error));
		});
		worker.once("exit", (code) => {
			if (settled || code === 0) return;
			finish(() =>
				reject(
					new ReconciliationClosestMatchError(
						`Closest-match worker exited with code ${code}`,
						"closest_match_worker_failed",
						500
					)
				)
			);
		});
	});
};

module.exports = {
	DEFAULT_TIMEOUT_MS,
	HARD_TIMEOUT_MS,
	runClosestReconciliationMatch,
};
