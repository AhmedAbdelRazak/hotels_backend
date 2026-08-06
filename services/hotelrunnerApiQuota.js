/** @format */

const HotelRunnerApiBudget = require("../models/hotelrunner_api_budget");

class HotelRunnerQuotaError extends Error {
	constructor(scope) {
		super("HotelRunner API request was held by the local quota budget.");
		this.name = "HotelRunnerQuotaError";
		this.code = "HOTELRUNNER_LOCAL_QUOTA_EXHAUSTED";
		this.scope = scope;
		this.retryable = true;
	}
}

const pad = (value) => String(value).padStart(2, "0");

function bucketWindows(now = new Date()) {
	const year = now.getUTCFullYear();
	const month = pad(now.getUTCMonth() + 1);
	const day = pad(now.getUTCDate());
	const hour = pad(now.getUTCHours());
	const minute = pad(now.getUTCMinutes());
	const dayKey = `${year}-${month}-${day}`;
	const minuteKey = `${dayKey}T${hour}:${minute}`;
	return {
		dayKey,
		minuteKey,
		dayExpiresAt: new Date(Date.UTC(year, now.getUTCMonth(), now.getUTCDate() + 3)),
		minuteExpiresAt: new Date(now.getTime() + 3 * 60 * 60 * 1000),
	};
}

async function claimBucket(
	{ bucketKey, scope, limit, expiresAt },
	{ BudgetModel = HotelRunnerApiBudget } = {}
) {
	try {
		const claimed = await BudgetModel.findOneAndUpdate(
			{
				bucketKey,
				$or: [{ count: { $lt: limit } }, { count: { $exists: false } }],
			},
			{
				$setOnInsert: { bucketKey, scope, limit, expiresAt },
				$inc: { count: 1 },
			},
			{ upsert: true, new: true, setDefaultsOnInsert: true }
		).exec();
		return Boolean(claimed && Number(claimed.count) <= limit);
	} catch (error) {
		if (error?.code === 11000) return false;
		throw error;
	}
}

async function reserveHotelRunnerApiCall(
	{ hotelId, hrIdFingerprint, quota, now = new Date() } = {},
	dependencies = {}
) {
	const windows = bucketWindows(now);
	const hotelKey = String(hotelId || "").trim();
	const appKey = String(hrIdFingerprint || "").trim().slice(0, 24);
	const buckets = [
		{
			bucketKey: `hotelrunner:property-day:${hotelKey}:${windows.dayKey}`,
			scope: "property_day",
			limit: quota.propertyDaily,
			expiresAt: windows.dayExpiresAt,
		},
		{
			bucketKey: `hotelrunner:property-minute:${hotelKey}:${windows.minuteKey}`,
			scope: "property_minute",
			limit: quota.propertyMinute,
			expiresAt: windows.minuteExpiresAt,
		},
		{
			bucketKey: `hotelrunner:application-minute:${appKey}:${windows.minuteKey}`,
			scope: "application_minute",
			limit: quota.applicationMinute,
			expiresAt: windows.minuteExpiresAt,
		},
	];
	for (const bucket of buckets) {
		if (!(await claimBucket(bucket, dependencies))) {
			throw new HotelRunnerQuotaError(bucket.scope);
		}
	}
	return true;
}

module.exports = {
	HotelRunnerQuotaError,
	bucketWindows,
	claimBucket,
	reserveHotelRunnerApiCall,
};
