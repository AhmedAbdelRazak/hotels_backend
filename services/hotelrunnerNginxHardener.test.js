/** @format */

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const scriptPath = path.resolve(
	__dirname,
	"../scripts/ops/hardenHotelRunnerNginxLogging.sh"
);
const source = fs.readFileSync(scriptPath, "utf8");

test("Nginx hardener takes a nonblocking deployment lock before inspection", () => {
	const lockOpen = source.indexOf('exec 9>"$lock_file"');
	const lockClaim = source.indexOf("flock -n 9");
	const firstInspection = source.indexOf('[[ ! -f "$target_file" ]]');

	assert.notEqual(lockOpen, -1);
	assert.ok(lockClaim > lockOpen);
	assert.ok(firstInspection > lockClaim);
	assert.match(
		source,
		/Another xHotelPro Nginx deployment is active; no changes were made\./
	);
});

test("Nginx hardener revalidates exact identity and content immediately before install", () => {
	assert.match(source, /original_identity="\$\(stat -Lc '%d:%i'/);
	assert.match(source, /original_hash="\$\(sha256sum/);
	assert.match(source, /current_identity="\$\(stat -Lc '%d:%i'/);
	assert.match(source, /current_hash="\$\(sha256sum/);
	assert.match(source, /current_identity" != "\$original_identity/);
	assert.match(source, /current_hash" != "\$original_hash/);

	const backup = source.indexOf('cp -a -- "$target_file" "$backup_file"');
	const install = source.indexOf(
		'install -o root -g root -m 0644 -- "$temporary_file" "$target_file"'
	);
	const guards = [...source.matchAll(/^assert_target_unchanged$/gm)].map(
		(match) => match.index
	);

	assert.equal(guards.length, 2);
	assert.ok(guards[0] < backup);
	assert.ok(guards[1] > backup && guards[1] < install);
	assert.match(
		source.slice(backup, guards[1]),
		/Nginx backup does not match the reviewed source; refusing install\./
	);
});

test("Nginx hardener retains test, reload, and rollback protections", () => {
	assert.match(
		source,
		/rollback\(\) \{[\s\S]*cp -a -- "\$backup_file" "\$target_file"[\s\S]*nginx -t[\s\S]*systemctl reload nginx[\s\S]*\}/
	);
	assert.match(source, /if ! nginx -t; then\s+rollback\s+exit 1\s+fi/);
	assert.match(
		source,
		/if ! systemctl reload nginx; then\s+rollback\s+exit 1\s+fi/
	);
});
