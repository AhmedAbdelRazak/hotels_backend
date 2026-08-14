/** @format */

"use strict";

const { parentPort, workerData } = require("worker_threads");
const {
	findClosestReconciliationMatch,
} = require("./reconciliationClosestMatch");

if (!parentPort) {
	throw new Error("reconciliationClosestMatchWorker must run in a worker thread");
}

try {
	const result = findClosestReconciliationMatch(
		workerData?.candidates,
		workerData?.targetCents,
		workerData?.options
	);
	parentPort.postMessage({ ok: true, result });
} catch (error) {
	parentPort.postMessage({
		ok: false,
		error: {
			name: String(error?.name || "Error"),
			message: String(error?.message || "Closest-match worker failed"),
			code: String(error?.code || "closest_match_worker_failed"),
			statusCode: Number(error?.statusCode) || 500,
		},
	});
}
