/** @format */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
	invalidatePublicHotelGuestReviewSummaryCache,
	__test: cache,
} = require("../controllers/janat");

const responseRecorder = () => ({
	headers: {},
	statusCode: null,
	payload: undefined,
	setHeader(name, value) {
		this.headers[name] = value;
	},
	status(statusCode) {
		this.statusCode = statusCode;
		return this;
	},
	json(payload) {
		this.payload = payload;
		return payload;
	},
});

test.beforeEach(() => {
	cache.resetPublicHotelResponseCache();
});

test.after(() => {
	cache.resetPublicHotelResponseCache();
});

test("guest-review invalidation deletes only caches that carry review summaries", () => {
	const reviewCacheKeys = [
		"active-hotels",
		"active-hotel-list",
		"room-query-list:2026-08-01_2026-08-03_all_2_0_makkah",
		"room-query-list:another-query",
	];
	const unrelatedCacheKeys = [
		"distinct-rooms",
		"active-hotels-extra",
		"room-query-list",
		"another-public-cache",
	];

	for (const key of [...reviewCacheKeys, ...unrelatedCacheKeys]) {
		cache.publicCacheSet(key, { key });
	}

	const generationBefore =
		cache.getPublicHotelGuestReviewCacheGeneration();
	const deletedKeys = invalidatePublicHotelGuestReviewSummaryCache();

	assert.equal(deletedKeys, reviewCacheKeys.length);
	assert.equal(
		cache.getPublicHotelGuestReviewCacheGeneration(),
		generationBefore + 1,
	);
	for (const key of reviewCacheKeys) {
		assert.equal(cache.publicCacheGet(key), null);
	}
	for (const key of unrelatedCacheKeys) {
		assert.deepEqual(cache.publicCacheGet(key), { key });
	}
});

test("an older in-flight review-summary loader cannot repopulate stale cache", async () => {
	let releaseOldLoader;
	const oldLoaderValue = [{ guestReviewSummary: { averageRating: 2 } }];
	const oldLoader = new Promise((resolve) => {
		releaseOldLoader = resolve;
	});
	const oldResponse = responseRecorder();
	const oldRequest = cache.sendCachedPublicJson(
		{},
		oldResponse,
		"active-hotels",
		() => oldLoader,
	);

	assert.equal(invalidatePublicHotelGuestReviewSummaryCache(), 0);
	releaseOldLoader(oldLoaderValue);
	await oldRequest;

	assert.deepEqual(oldResponse.payload, oldLoaderValue);
	assert.equal(cache.publicCacheGet("active-hotels"), null);

	const freshValue = [{ guestReviewSummary: { averageRating: 5 } }];
	let freshLoaderCalls = 0;
	const freshResponse = responseRecorder();
	await cache.sendCachedPublicJson(
		{},
		freshResponse,
		"active-hotels",
		async () => {
			freshLoaderCalls += 1;
			return freshValue;
		},
	);

	const cachedResponse = responseRecorder();
	await cache.sendCachedPublicJson(
		{},
		cachedResponse,
		"active-hotels",
		async () => {
			freshLoaderCalls += 1;
			return [{ guestReviewSummary: { averageRating: 1 } }];
		},
	);

	assert.equal(freshLoaderCalls, 1);
	assert.deepEqual(cachedResponse.payload, freshValue);
	assert.equal(
		cachedResponse.headers["Cache-Control"],
		"no-store, max-age=0",
	);
});

test("review invalidation does not disrupt an in-flight distinct-room cache load", async () => {
	let releaseLoader;
	const distinctRooms = [{ roomType: "double" }];
	const loader = new Promise((resolve) => {
		releaseLoader = resolve;
	});
	const firstResponse = responseRecorder();
	const firstRequest = cache.sendCachedPublicJson(
		{},
		firstResponse,
		"distinct-rooms",
		() => loader,
	);

	invalidatePublicHotelGuestReviewSummaryCache();
	releaseLoader(distinctRooms);
	await firstRequest;

	let secondLoaderCalls = 0;
	const secondResponse = responseRecorder();
	await cache.sendCachedPublicJson(
		{},
		secondResponse,
		"distinct-rooms",
		async () => {
			secondLoaderCalls += 1;
			return [];
		},
	);

	assert.equal(secondLoaderCalls, 0);
	assert.deepEqual(secondResponse.payload, distinctRooms);
	assert.equal(
		secondResponse.headers["Cache-Control"],
		"public, max-age=60, s-maxage=120",
	);
});

test("public hotel cache keeps its existing 60-second TTL", () => {
	const originalNow = Date.now;
	let now = 1_000_000;
	Date.now = () => now;

	try {
		cache.publicCacheSet("distinct-rooms", ["double"]);
		now += 60_000;
		assert.deepEqual(cache.publicCacheGet("distinct-rooms"), ["double"]);

		now += 1;
		assert.equal(cache.publicCacheGet("distinct-rooms"), null);
	} finally {
		Date.now = originalNow;
	}
});
