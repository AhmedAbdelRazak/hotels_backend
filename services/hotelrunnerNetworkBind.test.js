/** @format */

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

test("the backend origin is loopback-bound by default", () => {
	const source = fs.readFileSync(require.resolve("../server"), "utf8");
	assert.match(
		source,
		/process\.env\.BIND_HOST\s*\|\|\s*"127\.0\.0\.1"/
	);
	assert.match(source, /server\.listen\(port, bindHost,/);
});
