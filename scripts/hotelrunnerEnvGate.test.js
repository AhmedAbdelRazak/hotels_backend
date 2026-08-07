/** @format */

"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const test = require("node:test");
const {
	CUTOFF_KEY,
	GATE_KEYS,
	runEnvGateCommand,
} = require("./hotelrunnerEnvGate");

const SCRIPT_PATH = path.join(__dirname, "hotelrunnerEnvGate.js");
const SYNTHETIC_TOKEN = "synthetic-hotelrunner-token-never-print";
const SYNTHETIC_HR_ID = "synthetic-hotelrunner-hr-id-never-print";
const LOCAL_HOTEL_ID = "6a40b6a1a6efe70450536038";

const temporaryDirectories = new Set();

const makeTemporaryDirectory = async () => {
	const directory = await fs.promises.mkdtemp(
		path.join(os.tmpdir(), "hotelrunner-env-gate-test-")
	);
	temporaryDirectories.add(directory);
	return directory;
};

const safeInheritedEnv = (overrides = {}) => ({
	...Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !key.startsWith("HOTELRUNNER_"))
	),
	...overrides,
});

const baseEnvText = ({ gates = "false", cutoff = "" } = {}) =>
	[
		"# unrelated configuration must remain byte-for-byte stable",
		"UNRELATED_SETTING=keep-me",
		`HOTELRUNNER_API_TOKEN=${SYNTHETIC_TOKEN}`,
		`HOTELRUNNER_API_HR_ID=${SYNTHETIC_HR_ID}`,
		`HOTELRUNNER_SUPPORTED_HOTELIDS=${LOCAL_HOTEL_ID}`,
		...GATE_KEYS.map((key) => `${key}=${gates}`),
		`${CUTOFF_KEY}=${cutoff}`,
		"TRAILING_SETTING=also-keep-me",
		"",
	].join("\n");

const writeEnvFixture = async (directory, text = baseEnvText()) => {
	const envFile = path.join(directory, "operator.env");
	await fs.promises.writeFile(envFile, text, { mode: 0o644 });
	return envFile;
};

test.afterEach(async () => {
	for (const directory of temporaryDirectories) {
		const resolved = path.resolve(directory);
		assert.equal(
			resolved.startsWith(path.resolve(os.tmpdir()) + path.sep),
			true,
			"test cleanup must remain below the OS temporary directory"
		);
		await fs.promises.rm(resolved, { recursive: true, force: true });
		temporaryDirectories.delete(directory);
	}
});

test("bootstrap creates an exact atomic backup and only rewrites managed gates", async () => {
	const directory = await makeTemporaryDirectory();
	const backupDirectory = path.join(directory, "backups");
	await fs.promises.mkdir(backupDirectory);
	const original = baseEnvText({
		gates: "true",
		cutoff: "2026-08-06T12:00:00-07:00",
	});
	const envFile = await writeEnvFixture(directory, original);
	const originalStat = await fs.promises.stat(envFile);

	const result = await runEnvGateCommand({
		command: "bootstrap",
		envFile,
		backupDir: backupDirectory,
		inheritedEnv: {},
	});

	assert.equal(result.schemaVersion, 1);
	assert.equal(result.backupCreated, true);
	assert.deepEqual(result.changedKeys, [...GATE_KEYS, CUTOFF_KEY]);
	const updated = await fs.promises.readFile(envFile, "utf8");
	const updatedStat = await fs.promises.stat(envFile);
	if (originalStat.ino && updatedStat.ino) {
		assert.notEqual(
			`${originalStat.dev}:${originalStat.ino}`,
			`${updatedStat.dev}:${updatedStat.ino}`,
			"the env file must be replaced by atomic rename instead of edited in place"
		);
	}
	assert.match(updated, /^# unrelated configuration must remain byte-for-byte stable/m);
	assert.match(updated, /^UNRELATED_SETTING=keep-me$/m);
	assert.match(updated, /^TRAILING_SETTING=also-keep-me$/m);
	for (const key of GATE_KEYS) assert.match(updated, new RegExp(`^${key}=false$`, "m"));
	assert.match(updated, new RegExp(`^${CUTOFF_KEY}=$`, "m"));
	assert.equal(updated.includes(SYNTHETIC_TOKEN), true);
	assert.equal(updated.includes(SYNTHETIC_HR_ID), true);

	const backupNames = (await fs.promises.readdir(backupDirectory)).filter((name) =>
		name.endsWith(".bak")
	);
	assert.equal(backupNames.length, 1);
	assert.match(backupNames[0], /hotelrunner-env-gate\.v1\./);
	assert.equal(
		await fs.promises.readFile(path.join(backupDirectory, backupNames[0]), "utf8"),
		original
	);
	const temporaryNames = (await fs.promises.readdir(directory)).filter((name) =>
		name.endsWith(".tmp")
	);
	assert.deepEqual(temporaryNames, []);
	if (process.platform !== "win32") {
		assert.equal((await fs.promises.stat(envFile)).mode & 0o777, 0o600);
		assert.equal(
			(await fs.promises.stat(path.join(backupDirectory, backupNames[0]))).mode &
				0o777,
			0o600
		);
	}
});

test("activate sets push projection, bounded room verification, and a timezone-qualified cutoff", async () => {
	const directory = await makeTemporaryDirectory();
	const envFile = await writeEnvFixture(directory);
	const cutoff = "2026-08-06T16:45:12-07:00";

	await runEnvGateCommand({
		command: "activate",
		envFile,
		notBefore: cutoff,
		inheritedEnv: {},
	});
	const updated = await fs.promises.readFile(envFile, "utf8");
	assert.match(updated, /^HOTELRUNNER_PROJECTION_ENABLED=true$/m);
	assert.match(updated, /^HOTELRUNNER_ROOM_LIST_SYNC_ENABLED=true$/m);
	assert.match(updated, /^HOTELRUNNER_PULL_ENABLED=false$/m);
	assert.match(updated, /^HOTELRUNNER_CONFIRM_DELIVERY_ENABLED=false$/m);
	assert.match(updated, new RegExp(`^${CUTOFF_KEY}=${cutoff}$`, "m"));

	const beforeInvalidActivation = await fs.promises.readFile(envFile, "utf8");
	const backupsBeforeInvalidActivation = (await fs.promises.readdir(directory)).filter(
		(name) => name.endsWith(".bak")
	).length;
	await assert.rejects(
		() =>
			runEnvGateCommand({
				command: "activate",
				envFile,
				notBefore: "2026-08-06T16:45:12",
				inheritedEnv: {},
			}),
		(error) => error.code === "INVALID_ACTIVATION_CUTOFF"
	);
	assert.equal(await fs.promises.readFile(envFile, "utf8"), beforeInvalidActivation);
	assert.equal(
		(await fs.promises.readdir(directory)).filter((name) => name.endsWith(".bak"))
			.length,
		backupsBeforeInvalidActivation
	);
});

test("deactivate restores every gate and clears the cutoff", async () => {
	const directory = await makeTemporaryDirectory();
	const envFile = await writeEnvFixture(
		directory,
		baseEnvText({ gates: "true", cutoff: "2026-08-06T12:00:00Z" })
	);
	await runEnvGateCommand({ command: "deactivate", envFile, inheritedEnv: {} });
	const updated = await fs.promises.readFile(envFile, "utf8");
	for (const key of GATE_KEYS) assert.match(updated, new RegExp(`^${key}=false$`, "m"));
	assert.match(updated, new RegExp(`^${CUTOFF_KEY}=$`, "m"));
});

test("rotate-token reads a replacement out of band, keeps gates closed, and never reports values", async () => {
	const directory = await makeTemporaryDirectory();
	const envFile = await writeEnvFixture(directory);
	const replacementToken = "replacement-hotelrunner-token-never-print";

	const result = await runEnvGateCommand({
		command: "rotate-token",
		envFile,
		secretInput: `${replacementToken}\n`,
		inheritedEnv: {},
	});
	const updated = await fs.promises.readFile(envFile, "utf8");
	assert.equal(result.backupCreated, true);
	assert.deepEqual(result.changedKeys, [
		...GATE_KEYS,
		CUTOFF_KEY,
		"HOTELRUNNER_API_TOKEN",
	]);
	assert.equal(updated.includes(replacementToken), true);
	assert.equal(updated.includes(SYNTHETIC_TOKEN), false);
	for (const key of GATE_KEYS) {
		assert.match(updated, new RegExp(`^${key}=false$`, "m"));
	}
	assert.match(updated, new RegExp(`^${CUTOFF_KEY}=$`, "m"));
	assert.equal(JSON.stringify(result).includes(replacementToken), false);
	assert.equal(JSON.stringify(result).includes(SYNTHETIC_TOKEN), false);

	const hashToken = "replacement-token-with-hash#fragment";
	await runEnvGateCommand({
		command: "rotate-token",
		envFile,
		secretInput: hashToken,
		inheritedEnv: {},
	});
	const hashUpdated = await fs.promises.readFile(envFile, "utf8");
	assert.match(
		hashUpdated,
		/^HOTELRUNNER_API_TOKEN=replacement-token-with-hash#fragment$/m
	);

	await assert.rejects(
		() =>
			runEnvGateCommand({
				command: "rotate-token",
				envFile,
				secretInput: hashToken,
				inheritedEnv: {},
			}),
		(error) => error.code === "TOKEN_UNCHANGED"
	);
});

test("rotate-token refuses open gates, active cutoffs, and malformed stdin before writing", async () => {
	const directory = await makeTemporaryDirectory();
	const envFile = await writeEnvFixture(directory);
	const replacementToken = "replacement-hotelrunner-token-never-print";
	const cases = [
		[
			baseEnvText().replace(
				"HOTELRUNNER_PROJECTION_ENABLED=false",
				"HOTELRUNNER_PROJECTION_ENABLED=true"
			),
			replacementToken,
			"TOKEN_ROTATION_GATE_OPEN",
		],
		[
			baseEnvText({ cutoff: "2026-08-06T23:45:12Z" }),
			replacementToken,
			"TOKEN_ROTATION_CUTOFF_SET",
		],
		[baseEnvText(), "short", "INVALID_TOKEN_INPUT"],
		[baseEnvText(), `${replacementToken}\nextra`, "INVALID_TOKEN_INPUT"],
		[
			baseEnvText(),
			"replacement token with internal spaces",
			"INVALID_TOKEN_INPUT",
		],
		[
			baseEnvText(),
			'"replacement-token-wrapped-in-quotes"',
			"ENV_RENDER_ROUNDTRIP_FAILED",
		],
	];

	for (const [source, secretInput, expectedCode] of cases) {
		await fs.promises.writeFile(envFile, source);
		const before = await fs.promises.readFile(envFile, "utf8");
		await assert.rejects(
			() =>
				runEnvGateCommand({
					command: "rotate-token",
					envFile,
					secretInput,
					inheritedEnv: {},
				}),
			(error) => error.code === expectedCode
		);
		assert.equal(await fs.promises.readFile(envFile, "utf8"), before);
	}
	assert.equal(
		(await fs.promises.readdir(directory)).some((name) => name.endsWith(".bak")),
		false,
		"invalid token input must fail before backup creation"
	);
});

test("room-discovery assertion requires explicit closed gates and rejects invalid booleans", async () => {
	const directory = await makeTemporaryDirectory();
	const envFile = await writeEnvFixture(directory);
	const result = await runEnvGateCommand({
		command: "assert-room-discovery",
		envFile,
		inheritedEnv: {},
	});
	assert.deepEqual(result, {
		schemaVersion: 1,
		command: "assert-room-discovery",
		ready: true,
	});

	const invalidText = baseEnvText().replace(
		"HOTELRUNNER_PULL_ENABLED=false",
		"HOTELRUNNER_PULL_ENABLED=maybe"
	);
	await fs.promises.writeFile(envFile, invalidText);
	await assert.rejects(
		() =>
			runEnvGateCommand({
				command: "assert-room-discovery",
				envFile,
				inheritedEnv: {},
			}),
		(error) =>
			error.code === "INVALID_BOOLEAN_GATE" &&
			error.message.includes("HOTELRUNNER_PULL_ENABLED") &&
			!error.message.includes("maybe")
	);

	await fs.promises.writeFile(
		envFile,
		baseEnvText().replace(
			`HOTELRUNNER_SUPPORTED_HOTELIDS=${LOCAL_HOTEL_ID}`,
			`HOTELRUNNER_SUPPORTED_HOTELIDS=${LOCAL_HOTEL_ID},6a40b6a1a6efe70450536039`
		)
	);
	await assert.rejects(
		() =>
			runEnvGateCommand({
				command: "assert-room-discovery",
				envFile,
				inheritedEnv: {},
			}),
		(error) => error.code === "ROOM_DISCOVERY_HOTEL_SCOPE_INVALID"
	);
});

test("room-discovery assertion rejects inherited conflicts without exposing values", async () => {
	const directory = await makeTemporaryDirectory();
	const envFile = await writeEnvFixture(directory);
	const inheritedSecret = "different-inherited-secret-never-print";

	await assert.rejects(
		() =>
			runEnvGateCommand({
				command: "assert-room-discovery",
				envFile,
				inheritedEnv: {
					HOTELRUNNER_API_TOKEN: inheritedSecret,
				},
			}),
		(error) =>
			error.code === "INHERITED_ENV_CONFLICT" &&
			error.message.includes("HOTELRUNNER_API_TOKEN") &&
			!error.message.includes(SYNTHETIC_TOKEN) &&
			!error.message.includes(inheritedSecret)
	);

	await assert.rejects(
		() =>
			runEnvGateCommand({
				command: "assert-room-discovery",
				envFile,
				inheritedEnv: {
					HOTELRUNNER_API_BASE_URL: "https://conflicting.invalid",
				},
			}),
		(error) =>
			error.code === "INHERITED_ENV_CONFLICT" &&
			error.message.includes("HOTELRUNNER_API_BASE_URL") &&
			!error.message.includes("conflicting.invalid")
	);
});

test("status and every mutation reject inherited HotelRunner conflicts before writing", async () => {
	const directory = await makeTemporaryDirectory();
	const envFile = await writeEnvFixture(directory);
	const inheritedSecret = "different-inherited-secret-never-print";

	for (const command of [
		"status",
		"bootstrap",
		"deactivate",
		"activate",
		"rotate-token",
	]) {
		const before = await fs.promises.readFile(envFile, "utf8");
		const options = {
			command,
			envFile,
			inheritedEnv: { HOTELRUNNER_API_TOKEN: inheritedSecret },
			...(command === "activate"
				? { notBefore: "2026-08-06T23:45:12Z" }
				: {}),
			...(command === "rotate-token"
				? { secretInput: "replacement-hotelrunner-token-never-print" }
				: {}),
		};
		await assert.rejects(
			() => runEnvGateCommand(options),
			(error) =>
				error.code === "INHERITED_ENV_CONFLICT" &&
				error.message.includes("HOTELRUNNER_API_TOKEN") &&
				!error.message.includes(SYNTHETIC_TOKEN) &&
				!error.message.includes(inheritedSecret)
		);
		assert.equal(await fs.promises.readFile(envFile, "utf8"), before);
	}

	assert.equal(
		(await fs.promises.readdir(directory)).some((name) => name.endsWith(".bak")),
		false,
		"inherited conflicts must fail before backups or mutations"
	);
});

test("status and mutation CLI output contain names and booleans but no env values", async () => {
	const directory = await makeTemporaryDirectory();
	const envFile = await writeEnvFixture(directory);
	const childEnv = safeInheritedEnv();

	for (const command of ["status", "bootstrap"]) {
		const child = spawnSync(
			process.execPath,
			[SCRIPT_PATH, command, "--env-file", envFile],
			{ encoding: "utf8", env: childEnv }
		);
		assert.equal(child.status, 0, child.stderr);
		const output = `${child.stdout}\n${child.stderr}`;
		assert.equal(output.includes(SYNTHETIC_TOKEN), false);
		assert.equal(output.includes(SYNTHETIC_HR_ID), false);
		assert.equal(output.includes(LOCAL_HOTEL_ID), false);
		assert.match(output, /HOTELRUNNER_PROJECTION_ENABLED|backupCreated/);
	}

	const rotatedEnvFile = await writeEnvFixture(
		directory,
		baseEnvText().replace("TRAILING_SETTING=also-keep-me", "ROTATION_CASE=true")
	);
	const replacementToken = "replacement-cli-token-never-print";
	const rotateChild = spawnSync(
		process.execPath,
		[SCRIPT_PATH, "rotate-token", "--env-file", rotatedEnvFile],
		{ encoding: "utf8", env: childEnv, input: replacementToken }
	);
	assert.equal(rotateChild.status, 0, rotateChild.stderr);
	const rotateOutput = `${rotateChild.stdout}\n${rotateChild.stderr}`;
	assert.equal(rotateOutput.includes(replacementToken), false);
	assert.equal(rotateOutput.includes(SYNTHETIC_TOKEN), false);
	assert.match(rotateOutput, /HOTELRUNNER_API_TOKEN|backupCreated/);
});

test("explicit env-file and backup-directory symlinks are refused", async (t) => {
	const directory = await makeTemporaryDirectory();
	const realEnv = await writeEnvFixture(directory);
	const envLink = path.join(directory, "operator-link.env");
	const realBackupDirectory = path.join(directory, "real-backups");
	const backupLink = path.join(directory, "backup-link");
	await fs.promises.mkdir(realBackupDirectory);
	try {
		await fs.promises.symlink(realEnv, envLink, "file");
		await fs.promises.symlink(realBackupDirectory, backupLink, "dir");
	} catch (error) {
		if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
			t.skip("symbolic links are unavailable in this test environment");
			return;
		}
		throw error;
	}

	await assert.rejects(
		() => runEnvGateCommand({ command: "status", envFile: envLink }),
		(error) => error.code === "ENV_FILE_SYMLINK"
	);
	await assert.rejects(
		() =>
			runEnvGateCommand({
				command: "bootstrap",
				envFile: realEnv,
				backupDir: backupLink,
			}),
		(error) => error.code === "BACKUP_DIR_SYMLINK"
	);
});

test("env and backup paths must have the required regular-file shape", async () => {
	const directory = await makeTemporaryDirectory();
	const envFile = await writeEnvFixture(directory);
	const notAFile = path.join(directory, "env-directory");
	const notADirectory = path.join(directory, "backup-file");
	await fs.promises.mkdir(notAFile);
	await fs.promises.writeFile(notADirectory, "not a directory");

	await assert.rejects(
		() => runEnvGateCommand({ command: "status", envFile: notAFile }),
		(error) => error.code === "ENV_FILE_NOT_REGULAR"
	);
	await assert.rejects(
		() =>
			runEnvGateCommand({
				command: "bootstrap",
				envFile,
				backupDir: notADirectory,
			}),
		(error) => error.code === "BACKUP_DIR_NOT_DIRECTORY"
	);
});

test("every command rejects duplicate HotelRunner keys without exposing values", async () => {
	const directory = await makeTemporaryDirectory();
	const duplicateSecret = "different-duplicate-secret-never-print";
	const envFile = await writeEnvFixture(
		directory,
		`${baseEnvText()}HOTELRUNNER_API_TOKEN=${duplicateSecret}\n`
	);

	for (const command of [
		"status",
		"assert-room-discovery",
		"bootstrap",
		"deactivate",
		"activate",
		"rotate-token",
	]) {
		await assert.rejects(
			() =>
				runEnvGateCommand({
					command,
					envFile,
					inheritedEnv: {},
					...(command === "activate"
						? { notBefore: "2026-08-06T23:45:12Z" }
						: {}),
					...(command === "rotate-token"
						? { secretInput: "replacement-hotelrunner-token-never-print" }
						: {}),
				}),
			(error) =>
				error.code === "DUPLICATE_HOTELRUNNER_KEY" &&
				error.message.includes("HOTELRUNNER_API_TOKEN") &&
				!error.message.includes(SYNTHETIC_TOKEN) &&
				!error.message.includes(duplicateSecret)
		);
	}

	assert.equal(
		(await fs.promises.readdir(directory)).some((name) => name.endsWith(".bak")),
		false,
		"duplicate rejection must happen before a backup or mutation"
	);
});
