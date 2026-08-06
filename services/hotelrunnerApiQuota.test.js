/** @format */

const test = require("node:test");
const assert = require("node:assert/strict");
const {
	HotelRunnerQuotaError,
	bucketWindows,
	claimBucket,
	reserveHotelRunnerApiCall,
} = require("./hotelrunnerApiQuota");

function fakeBudgetModel(handler) {
	return {
		calls: [],
		findOneAndUpdate(filter, update, options) {
			const call = { filter, update, options };
			this.calls.push(call);
			return {
				exec: () => handler(call, this.calls.length - 1),
			};
		},
	};
}

test("quota bucket windows are based on UTC calendar and minute boundaries", () => {
	const now = new Date("2026-08-06T23:59:30.123Z");
	const windows = bucketWindows(now);

	assert.equal(windows.dayKey, "2026-08-06");
	assert.equal(windows.minuteKey, "2026-08-06T23:59");
	assert.equal(windows.dayExpiresAt.toISOString(), "2026-08-09T00:00:00.000Z");
	assert.equal(windows.minuteExpiresAt.toISOString(), "2026-08-07T02:59:30.123Z");
	assert.equal(now.toISOString(), "2026-08-06T23:59:30.123Z");
});

test("claimBucket performs a single atomic bounded increment", async () => {
	const BudgetModel = fakeBudgetModel(async () => ({ count: 3 }));
	const expiresAt = new Date("2026-08-09T00:00:00.000Z");
	const claimed = await claimBucket(
		{
			bucketKey: "synthetic-bucket",
			scope: "property_day",
			limit: 4,
			expiresAt,
		},
		{ BudgetModel }
	);

	assert.equal(claimed, true);
	assert.equal(BudgetModel.calls.length, 1);
	assert.deepEqual(BudgetModel.calls[0], {
		filter: {
			bucketKey: "synthetic-bucket",
			$or: [{ count: { $lt: 4 } }, { count: { $exists: false } }],
		},
		update: {
			$setOnInsert: {
				bucketKey: "synthetic-bucket",
				scope: "property_day",
				limit: 4,
				expiresAt,
			},
			$inc: { count: 1 },
		},
		options: { upsert: true, new: true, setDefaultsOnInsert: true },
	});
});

test("claimBucket treats a duplicate-key race or an over-limit result as denied", async () => {
	const duplicateRace = fakeBudgetModel(async () => {
		const error = new Error("synthetic duplicate race");
		error.code = 11000;
		throw error;
	});
	assert.equal(
		await claimBucket(
			{
				bucketKey: "race",
				scope: "property_minute",
				limit: 4,
				expiresAt: new Date(),
			},
			{ BudgetModel: duplicateRace }
		),
		false
	);

	const overLimit = fakeBudgetModel(async () => ({ count: 5 }));
	assert.equal(
		await claimBucket(
			{
				bucketKey: "over-limit",
				scope: "property_minute",
				limit: 4,
				expiresAt: new Date(),
			},
			{ BudgetModel: overLimit }
		),
		false
	);
});

test("reserving one HotelRunner call consumes all three local safety budgets", async () => {
	const BudgetModel = fakeBudgetModel(async (_call, index) => ({ count: index + 1 }));
	const now = new Date("2026-08-06T12:34:56.000Z");
	const reserved = await reserveHotelRunnerApiCall(
		{
			hotelId: "hotel-local-1",
			hrIdFingerprint: "abcdefghijklmnopqrstuvwxyz0123456789",
			quota: {
				propertyDaily: 225,
				propertyMinute: 4,
				applicationMinute: 60,
			},
			now,
		},
		{ BudgetModel }
	);

	assert.equal(reserved, true);
	assert.equal(BudgetModel.calls.length, 3);
	assert.deepEqual(
		BudgetModel.calls.map((call) => [
			call.update.$setOnInsert.scope,
			call.update.$setOnInsert.limit,
			call.filter.bucketKey,
		]),
		[
			[
				"property_day",
				225,
				"hotelrunner:property-day:hotel-local-1:2026-08-06",
			],
			[
				"property_minute",
				4,
				"hotelrunner:property-minute:hotel-local-1:2026-08-06T12:34",
			],
			[
				"application_minute",
				60,
				"hotelrunner:application-minute:abcdefghijklmnopqrstuvwx:2026-08-06T12:34",
			],
		]
	);
});

test("a denied bucket stops before later counters and raises a retryable scoped error", async () => {
	const BudgetModel = fakeBudgetModel(async (_call, index) => {
		if (index === 1) {
			const error = new Error("synthetic minute race");
			error.code = 11000;
			throw error;
		}
		return { count: 1 };
	});

	await assert.rejects(
		reserveHotelRunnerApiCall(
			{
				hotelId: "hotel-local-1",
				hrIdFingerprint: "fingerprint",
				quota: {
					propertyDaily: 225,
					propertyMinute: 4,
					applicationMinute: 60,
				},
				now: new Date("2026-08-06T12:34:56.000Z"),
			},
			{ BudgetModel }
		),
		(error) => {
			assert.ok(error instanceof HotelRunnerQuotaError);
			assert.equal(error.code, "HOTELRUNNER_LOCAL_QUOTA_EXHAUSTED");
			assert.equal(error.scope, "property_minute");
			assert.equal(error.retryable, true);
			return true;
		}
	);
	assert.equal(BudgetModel.calls.length, 2);
});

test("unexpected quota storage errors are not mistaken for ordinary rate limiting", async () => {
	const BudgetModel = fakeBudgetModel(async () => {
		const error = new Error("synthetic storage outage");
		error.code = "STORAGE_DOWN";
		throw error;
	});
	await assert.rejects(
		claimBucket(
			{
				bucketKey: "storage-error",
				scope: "property_day",
				limit: 225,
				expiresAt: new Date(),
			},
			{ BudgetModel }
		),
		/storage outage/
	);
});
