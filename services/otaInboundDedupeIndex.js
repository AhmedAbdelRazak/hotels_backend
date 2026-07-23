/** @format */

"use strict";

const InboundEmail = require("../models/inbound_email");

const INBOUND_DEDUPE_INDEX_UNAVAILABLE = "INBOUND_DEDUPE_INDEX_UNAVAILABLE";
const INBOUND_DEDUPE_INDEX_FIELDS = Object.freeze({ dedupeKey: 1 });
const INBOUND_DEDUPE_INDEX_OPTIONS = Object.freeze({
	unique: true,
	name: "uniq_inbound_email_dedupe_key",
	partialFilterExpression: {
		dedupeKey: { $type: "string", $gt: "" },
	},
});

let readinessPromise = null;

const createInboundDedupeIndex = (collection = InboundEmail.collection) =>
	collection.createIndex(
		INBOUND_DEDUPE_INDEX_FIELDS,
		INBOUND_DEDUPE_INDEX_OPTIONS,
	);

const ensureInboundDedupeIndex = () => {
	if (!readinessPromise) {
		readinessPromise = Promise.resolve(createInboundDedupeIndex()).catch(
			(cause) => {
				readinessPromise = null;
				const error = new Error(
					"The inbound delivery dedupe index is unavailable; the webhook was not accepted.",
				);
				error.code = INBOUND_DEDUPE_INDEX_UNAVAILABLE;
				error.cause = cause;
				throw error;
			},
		);
	}
	return readinessPromise;
};

module.exports = {
	INBOUND_DEDUPE_INDEX_FIELDS,
	INBOUND_DEDUPE_INDEX_OPTIONS,
	INBOUND_DEDUPE_INDEX_UNAVAILABLE,
	createInboundDedupeIndex,
	ensureInboundDedupeIndex,
};
