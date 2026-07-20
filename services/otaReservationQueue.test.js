/** @format */

const test = require("node:test");
const assert = require("node:assert/strict");
const {
	enqueueOtaReservationWork,
	getOtaReservationQueueSnapshot,
	waitForOtaReservationQueueIdle,
} = require("./otaReservationQueue");

const delay = (milliseconds) =>
	new Promise((resolve) => setTimeout(resolve, milliseconds));

test("OTA reservation work runs one job at a time in FIFO order", async () => {
	let active = 0;
	let maxActive = 0;
	const events = [];

	const task = (name, milliseconds) =>
		enqueueOtaReservationWork(async () => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			events.push(`start:${name}`);
			await delay(milliseconds);
			events.push(`finish:${name}`);
			active -= 1;
			return name;
		}, { confirmationNumber: name });

	const results = await Promise.all([
		task("first", 20),
		task("second", 5),
		task("third", 1),
	]);

	assert.deepEqual(results, ["first", "second", "third"]);
	assert.equal(maxActive, 1);
	assert.deepEqual(events, [
		"start:first",
		"finish:first",
		"start:second",
		"finish:second",
		"start:third",
		"finish:third",
	]);
	assert.deepEqual(getOtaReservationQueueSnapshot(), {
		active: 0,
		waiting: 0,
		depth: 0,
	});
});

test("a failed OTA job does not block the queue", async () => {
	const events = [];
	const failed = enqueueOtaReservationWork(async () => {
		events.push("failed:start");
		throw new Error("expected test failure");
	});
	const recovered = enqueueOtaReservationWork(async () => {
		events.push("recovered:start");
		return "recovered";
	});

	await assert.rejects(failed, /expected test failure/);
	assert.equal(await recovered, "recovered");
	await waitForOtaReservationQueueIdle();
	assert.deepEqual(events, ["failed:start", "recovered:start"]);
	assert.equal(getOtaReservationQueueSnapshot().depth, 0);
});
