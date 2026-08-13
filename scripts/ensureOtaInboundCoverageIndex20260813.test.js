/** @format */

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
	EXPLAIN_LIMIT,
	INDEX_KEY,
	INDEX_NAME,
	INDEX_OPTIONS,
	ensureOtaInboundCoverageIndex,
	main,
	preflightIndexCatalog,
	verifiedCatalogEntry,
} = require("./ensureOtaInboundCoverageIndex20260813");

const AS_OF = new Date("2026-08-13T22:00:00.000Z");
const exactSpec = () => ({
	v: 2,
	key: { ...INDEX_KEY },
	name: INDEX_NAME,
});

function fakeCollection({ initialIndexes = [], explainIndexName = INDEX_NAME } = {}) {
	let indexes = initialIndexes.map((spec) => ({ ...spec, key: { ...spec.key } }));
	const calls = {
		createIndex: [],
		find: [],
		sort: [],
		hint: [],
		limit: [],
		explain: [],
	};
	const collection = {
		async indexes() {
			return indexes.map((spec) => ({ ...spec, key: { ...spec.key } }));
		},
		async createIndex(key, options) {
			calls.createIndex.push({ key, options });
			indexes.push({ v: 2, key: { ...key }, name: options.name });
			return options.name;
		},
		find(filter, options) {
			calls.find.push({ filter, options });
			const query = {
				sort(value) {
					calls.sort.push(value);
					return query;
				},
				hint(value) {
					calls.hint.push(value);
					return query;
				},
				limit(value) {
					calls.limit.push(value);
					return query;
				},
				async explain(value) {
					calls.explain.push(value);
					return {
						queryPlanner: {
							winningPlan: {
								stage: "FETCH",
								inputStage: {
									stage: "IXSCAN",
									indexName: explainIndexName,
								},
							},
						},
						executionStats: {
							nReturned: 3,
							totalKeysExamined: 4,
							totalDocsExamined: 3,
							executionTimeMillis: 1,
						},
					};
				},
			};
			return query;
		},
	};
	return { calls, collection };
}

test("ensure creates only the exact nonunique index and verifies a hinted bounded plan", async () => {
	const { calls, collection } = fakeCollection({
		initialIndexes: [{ v: 2, key: { _id: 1 }, name: "_id_", unique: true }],
	});
	const result = await ensureOtaInboundCoverageIndex({ collection, asOf: AS_OF });

	assert.equal(result.status, "created");
	assert.deepEqual(result.key, INDEX_KEY);
	assert.equal(result.name, INDEX_NAME);
	assert.equal(result.readOnlyVerification, true);
	assert.deepEqual(calls.createIndex, [
		{ key: INDEX_KEY, options: INDEX_OPTIONS },
	]);
	assert.equal(Object.hasOwn(calls.createIndex[0].options, "background"), false);
	assert.equal(Object.hasOwn(calls.createIndex[0].options, "unique"), false);
	assert.equal(Object.hasOwn(calls.createIndex[0].options, "sparse"), false);
	assert.equal(Object.hasOwn(calls.createIndex[0].options, "partialFilterExpression"), false);
	assert.equal(calls.find.length, 1);
	assert.equal(
		calls.find[0].filter["senderAuthentication.authenticatedAligned"],
		true
	);
	assert.deepEqual(calls.find[0].options, { projection: { _id: 1 } });
	assert.deepEqual(calls.sort, [{ receivedAt: 1, _id: 1 }]);
	assert.deepEqual(calls.hint, [INDEX_NAME]);
	assert.deepEqual(calls.limit, [EXPLAIN_LIMIT]);
	assert.deepEqual(calls.explain, ["executionStats"]);
	assert.equal(result.nReturned, 3);
});

test("ensure is idempotent when the exact catalog entry already exists", async () => {
	const { calls, collection } = fakeCollection({ initialIndexes: [exactSpec()] });
	const result = await ensureOtaInboundCoverageIndex({ collection, asOf: AS_OF });
	assert.equal(result.status, "already_ready");
	assert.equal(calls.createIndex.length, 0);
	assert.deepEqual(calls.hint, [INDEX_NAME]);
});

test("preflight rejects the exact name with any different key or unsafe option", () => {
	assert.throws(
		() =>
			preflightIndexCatalog([
				{ name: INDEX_NAME, key: { receivedAt: -1 } },
			]),
		(error) => error.code === "OTA_COVERAGE_INDEX_NAME_CONFLICT"
	);
	for (const option of [
		{ unique: true },
		{ sparse: true },
		{ hidden: true },
		{ partialFilterExpression: { receivedAt: { $exists: true } } },
		{ collation: { locale: "en" } },
		{ expireAfterSeconds: 1 },
		{ expireAfterSeconds: 0 },
		{ prepareUnique: true },
	]) {
		assert.throws(
			() => preflightIndexCatalog([{ ...exactSpec(), ...option }]),
			(error) => error.code === "OTA_COVERAGE_INDEX_NAME_CONFLICT"
		);
	}
});

test("preflight rejects the same key under another name", () => {
	assert.throws(
		() =>
			preflightIndexCatalog([
				{ name: "unexpected_name", key: { ...INDEX_KEY } },
			]),
		(error) => error.code === "OTA_COVERAGE_INDEX_PATTERN_CONFLICT"
	);
});

test("post-create verification rejects an unexpected plan or catalog entry", async () => {
	assert.throws(
		() => verifiedCatalogEntry([]),
		(error) => error.code === "OTA_COVERAGE_INDEX_VERIFY_FAILED"
	);
	const { collection } = fakeCollection({ explainIndexName: "_id_" });
	await assert.rejects(
		ensureOtaInboundCoverageIndex({ collection, asOf: AS_OF }),
		(error) => error.code === "OTA_COVERAGE_INDEX_PLAN_VERIFY_FAILED"
	);
});

test("CLI main uses no implicit connect in tests and emits only PII-free result JSON", async () => {
	let output = "";
	const privateValue = "PRIVATE GUEST must never print";
	const result = await main([], {
		skipConnect: true,
		ensure: async () => ({
			status: "already_ready",
			name: INDEX_NAME,
			key: { ...INDEX_KEY },
			readOnlyVerification: true,
			nReturned: 1,
			totalKeysExamined: 1,
			totalDocsExamined: 1,
			executionTimeMillis: 0,
		}),
		write: (value) => {
			output += value;
		},
		privateValue,
	});
	assert.equal(result.status, "already_ready");
	assert.equal(output.includes(privateValue), false);
	assert.deepEqual(JSON.parse(output), result);
	await assert.rejects(
		main(["--drop"], { skipConnect: true }),
		(error) => error.code === "OTA_COVERAGE_INDEX_UNSUPPORTED_ARGUMENT"
	);
});
