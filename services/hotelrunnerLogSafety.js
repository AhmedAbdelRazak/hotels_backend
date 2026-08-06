/** @format */

"use strict";

const HOTELRUNNER_CALLBACK_PATH = /^\/api\/hotelrunner\/callback\/?$/i;
const SENSITIVE_QUERY_PARAMETER =
	/([?&](?:token|secret|hr_id)=)[^&#\s]*/gi;

function sanitizeRequestUrlForLogs(value = "") {
	const raw = String(value || "");
	const queryIndex = raw.indexOf("?");
	const path = queryIndex >= 0 ? raw.slice(0, queryIndex) : raw;
	if (queryIndex >= 0 && HOTELRUNNER_CALLBACK_PATH.test(path)) {
		// The callback authentication contract is query-based. Redact the entire
		// query, including unexpected parameter names, so future credentials cannot
		// accidentally enter access logs when HotelRunner changes its request shape.
		return `${path}?[REDACTED]`;
	}
	return raw.replace(SENSITIVE_QUERY_PARAMETER, "$1[REDACTED]");
}

module.exports = { sanitizeRequestUrlForLogs };
