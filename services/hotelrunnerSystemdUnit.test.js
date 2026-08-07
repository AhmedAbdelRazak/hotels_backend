/** @format */

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("the production worker unit is isolated, persistent, and never carries credentials", () => {
	const source = fs.readFileSync(
		path.resolve(
			__dirname,
			"../ops/systemd/xhotelpro-hotelrunner-sync.service"
		),
		"utf8"
	);
	assert.match(source, /^User=ahmedadmin$/m);
	assert.match(source, /^Group=ahmedadmin$/m);
	assert.match(source, /^ExecStart=\/usr\/bin\/node .*hotelrunnerSyncWorker\.js$/m);
	assert.match(source, /^Restart=always$/m);
	assert.match(source, /^MemoryMax=256M$/m);
	assert.match(source, /^NoNewPrivileges=true$/m);
	assert.match(source, /^ProtectSystem=strict$/m);
	assert.match(source, /^ProtectHome=read-only$/m);
	assert.match(source, /^WantedBy=multi-user\.target$/m);
	assert.doesNotMatch(source, /EnvironmentFile|HOTELRUNNER_|TOKEN|HR_ID|pm2/i);
});
