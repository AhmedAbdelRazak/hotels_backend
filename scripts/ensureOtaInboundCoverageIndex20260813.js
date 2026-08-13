#!/usr/bin/env node
/** @format */

"use strict";

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const mongoose = require("mongoose");

// This narrowly scoped deployment command must never let importing the model
// trigger any other collection or index creation.
mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);

const InboundEmail = require("../models/inbound_email");
const {
	ARCHIVE_START,
	buildArchiveCandidateFilter,
} = require("../services/otaInboundCoverageAudit20260813");

const INDEX_NAME = "inbound_authenticated_received_at";
const INDEX_KEY = Object.freeze({
	"senderAuthentication.authenticatedAligned": 1,
	receivedAt: -1,
	_id: -1,
});
const INDEX_OPTIONS = Object.freeze({ name: INDEX_NAME });
const EXPLAIN_LIMIT = 10001;

const clean = (value) => String(value ?? "").trim();

function sameKey(actual = {}, expected = INDEX_KEY) {
	const actualEntries = Object.entries(actual || {});
	const expectedEntries = Object.entries(expected || {});
	return (
		actualEntries.length === expectedEntries.length &&
		actualEntries.every(
			([field, direction], index) =>
				field === expectedEntries[index][0] &&
				Number(direction) === Number(expectedEntries[index][1])
		)
	);
}

function safeExactOptions(spec = {}) {
	const hasOwn = (field) => Object.prototype.hasOwnProperty.call(spec, field);
	return Boolean(
		spec.unique !== true &&
			spec.sparse !== true &&
			spec.hidden !== true &&
			spec.prepareUnique !== true &&
			!hasOwn("partialFilterExpression") &&
			!hasOwn("collation") &&
			!hasOwn("expireAfterSeconds")
	);
}

function preflightIndexCatalog(indexes = []) {
	const byName = indexes.find((spec) => spec?.name === INDEX_NAME) || null;
	const samePatternOtherName =
		indexes.find(
			(spec) => spec?.name !== INDEX_NAME && sameKey(spec?.key)
		) || null;
	if (byName && (!sameKey(byName.key) || !safeExactOptions(byName))) {
		const error = new Error(
			"The coverage index name already has a different specification."
		);
		error.code = "OTA_COVERAGE_INDEX_NAME_CONFLICT";
		throw error;
	}
	if (samePatternOtherName) {
		const error = new Error(
			"The coverage index key already exists under a different name."
		);
		error.code = "OTA_COVERAGE_INDEX_PATTERN_CONFLICT";
		throw error;
	}
	return { alreadyReady: Boolean(byName) };
}

function verifiedCatalogEntry(indexes = []) {
	const ready = indexes.find((spec) => spec?.name === INDEX_NAME);
	if (!ready || !sameKey(ready.key) || !safeExactOptions(ready)) {
		const error = new Error(
			"The coverage index did not verify with its exact catalog specification."
		);
		error.code = "OTA_COVERAGE_INDEX_VERIFY_FAILED";
		throw error;
	}
	return ready;
}

function planIndexNames(node, names = new Set()) {
	if (!node || typeof node !== "object") return names;
	if (typeof node.indexName === "string") names.add(node.indexName);
	for (const value of Object.values(node)) planIndexNames(value, names);
	return names;
}

async function explainWithIndex(collection, { asOf = new Date() } = {}) {
	const asOfDate = asOf instanceof Date ? new Date(asOf) : new Date(asOf);
	if (!Number.isFinite(asOfDate.getTime())) {
		throw new TypeError("asOf must be a valid date.");
	}
	const explain = await collection
		.find(
			buildArchiveCandidateFilter({ since: ARCHIVE_START, asOf: asOfDate }),
			{ projection: { _id: 1 } }
		)
		.sort({ receivedAt: 1, _id: 1 })
		.hint(INDEX_NAME)
		.limit(EXPLAIN_LIMIT)
		.explain("executionStats");
	const usedIndexes = [...planIndexNames(explain?.queryPlanner?.winningPlan)];
	if (!usedIndexes.includes(INDEX_NAME)) {
		const error = new Error(
			"The hinted coverage query did not use the ensured index."
		);
		error.code = "OTA_COVERAGE_INDEX_PLAN_VERIFY_FAILED";
		throw error;
	}
	return {
		nReturned: Number(explain?.executionStats?.nReturned || 0),
		totalKeysExamined: Number(
			explain?.executionStats?.totalKeysExamined || 0
		),
		totalDocsExamined: Number(
			explain?.executionStats?.totalDocsExamined || 0
		),
		executionTimeMillis: Number(
			explain?.executionStats?.executionTimeMillis || 0
		),
	};
}

async function ensureOtaInboundCoverageIndex({
	collection = InboundEmail.collection,
	asOf = new Date(),
} = {}) {
	if (
		!collection?.indexes ||
		!collection?.createIndex ||
		!collection?.find
	) {
		throw new TypeError("A MongoDB collection with index/query methods is required.");
	}
	const before = await collection.indexes();
	const { alreadyReady } = preflightIndexCatalog(before);
	if (!alreadyReady) {
		const createdName = await collection.createIndex(INDEX_KEY, INDEX_OPTIONS);
		if (createdName !== INDEX_NAME) {
			const error = new Error("MongoDB returned an unexpected index name.");
			error.code = "OTA_COVERAGE_INDEX_UNEXPECTED_NAME";
			throw error;
		}
	}
	verifiedCatalogEntry(await collection.indexes());
	const plan = await explainWithIndex(collection, { asOf });
	return {
		status: alreadyReady ? "already_ready" : "created",
		name: INDEX_NAME,
		key: { ...INDEX_KEY },
		readOnlyVerification: true,
		...plan,
	};
}

async function main(
	argv = process.argv.slice(2),
	dependencies = {}
) {
	if (argv.length) {
		const error = new TypeError("This command accepts no arguments.");
		error.code = "OTA_COVERAGE_INDEX_UNSUPPORTED_ARGUMENT";
		throw error;
	}
	const database = dependencies.database || process.env.DATABASE;
	if (!database && !dependencies.skipConnect) {
		const error = new Error("DATABASE is not configured.");
		error.code = "OTA_COVERAGE_INDEX_DATABASE_REQUIRED";
		throw error;
	}
	const connect = dependencies.connect || mongoose.connect.bind(mongoose);
	const disconnect = dependencies.disconnect || mongoose.disconnect.bind(mongoose);
	try {
		if (!dependencies.skipConnect) {
			mongoose.set("strictQuery", false);
			await connect(database, {
				autoIndex: false,
				autoCreate: false,
			});
		}
		const result = await (
			dependencies.ensure || ensureOtaInboundCoverageIndex
		)({
			collection: dependencies.collection || InboundEmail.collection,
			asOf: dependencies.asOf || new Date(),
		});
		(dependencies.write || process.stdout.write.bind(process.stdout))(
			`${JSON.stringify(result)}\n`
		);
		return result;
	} finally {
		if (!dependencies.skipConnect && mongoose.connection.readyState !== 0) {
			await disconnect();
		}
	}
}

if (require.main === module) {
	main().catch(async (error) => {
		const safeCode = clean(
			error?.code || error?.name || "OTA_COVERAGE_INDEX_ENSURE_FAILED"
		)
			.replace(/[^A-Za-z0-9_-]/g, "")
			.slice(0, 80);
		process.stderr.write(`OTA coverage index ensure failed (${safeCode}).\n`);
		process.exitCode = 1;
		if (mongoose.connection.readyState !== 0) {
			await mongoose.disconnect().catch(() => null);
		}
	});
}

module.exports = {
	EXPLAIN_LIMIT,
	INDEX_KEY,
	INDEX_NAME,
	INDEX_OPTIONS,
	ensureOtaInboundCoverageIndex,
	explainWithIndex,
	main,
	planIndexNames,
	preflightIndexCatalog,
	safeExactOptions,
	sameKey,
	verifiedCatalogEntry,
};
