/** @format */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { sanitizeRequestUrlForLogs } = require("./hotelrunnerLogSafety");

test("HotelRunner callback access logs redact the complete query", () => {
	const secrets = [
		"real-token-must-never-log",
		"real-hr-id-must-never-log",
		"future-credential-name-must-never-log",
	];
	const sanitized = sanitizeRequestUrlForLogs(
		`/api/hotelrunner/callback?token=${secrets[0]}&hr_id=${secrets[1]}&future_key=${secrets[2]}`
	);
	assert.equal(sanitized, "/api/hotelrunner/callback?[REDACTED]");
	for (const secret of secrets) assert.equal(sanitized.includes(secret), false);
});

test("generic URL logging still redacts known credential parameters", () => {
	assert.equal(
		sanitizeRequestUrlForLogs("/api/example?view=1&secret=hidden&token=also-hidden"),
		"/api/example?view=1&secret=[REDACTED]&token=[REDACTED]"
	);
	assert.equal(sanitizeRequestUrlForLogs("/api/example?view=1"), "/api/example?view=1");
});
