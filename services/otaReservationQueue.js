/** @format */

let queueTail = Promise.resolve();
let nextJobNumber = 0;
let activeJobs = 0;
let waitingJobs = 0;

const queueSnapshot = () => ({
	active: activeJobs,
	waiting: waitingJobs,
	depth: activeJobs + waitingJobs,
});

const logQueue = (stage, payload = {}) => {
	console.log(`[ota-queue] ${stage}`, {
		at: new Date().toISOString(),
		...payload,
	});
};

const enqueueOtaReservationWork = (task, context = {}) => {
	if (typeof task !== "function") {
		return Promise.reject(new TypeError("OTA queue task must be a function."));
	}

	const jobNumber = ++nextJobNumber;
	waitingJobs += 1;
	logQueue("queued", {
		jobNumber,
		...queueSnapshot(),
		...context,
	});

	const run = async () => {
		waitingJobs -= 1;
		activeJobs += 1;
		const startedAt = Date.now();
		logQueue("started", {
			jobNumber,
			...queueSnapshot(),
			...context,
		});

		try {
			return await task();
		} finally {
			activeJobs -= 1;
			logQueue("finished", {
				jobNumber,
				durationMs: Date.now() - startedAt,
				...queueSnapshot(),
				...context,
			});
		}
	};

	const result = queueTail.then(run, run);
	queueTail = result.then(
		() => undefined,
		() => undefined
	);
	return result;
};

const waitForOtaReservationQueueIdle = () => queueTail;

module.exports = {
	enqueueOtaReservationWork,
	getOtaReservationQueueSnapshot: queueSnapshot,
	waitForOtaReservationQueueIdle,
};
