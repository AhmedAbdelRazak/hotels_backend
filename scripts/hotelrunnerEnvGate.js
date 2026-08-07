/** @format */

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const {
	parseIsoTimestamp,
	parseSupportedHotelIds,
} = require("../services/hotelrunnerConfig");

const TOOL_VERSION = 1;
const GATE_KEYS = Object.freeze([
	"HOTELRUNNER_PROJECTION_ENABLED",
	"HOTELRUNNER_PULL_ENABLED",
	"HOTELRUNNER_ROOM_LIST_SYNC_ENABLED",
	"HOTELRUNNER_CONFIRM_DELIVERY_ENABLED",
]);
const CUTOFF_KEY = "HOTELRUNNER_PROJECTION_NOT_BEFORE";
const REVIEW_MODE_KEY = "HOTELRUNNER_REQUIRE_OTA_REVIEW";
const CREDENTIAL_KEYS = Object.freeze([
	"HOTELRUNNER_API_TOKEN",
	"HOTELRUNNER_API_HR_ID",
]);
const SUPPORTED_HOTELS_KEY = "HOTELRUNNER_SUPPORTED_HOTELIDS";
const ASSERTION_KEYS = Object.freeze([
	...GATE_KEYS,
	CUTOFF_KEY,
	REVIEW_MODE_KEY,
	...CREDENTIAL_KEYS,
	SUPPORTED_HOTELS_KEY,
]);
const TOKEN_ROTATION_COMMAND = "rotate-token";
const REVIEW_MODE_COMMAND = "set-review-mode";
const MUTATING_COMMANDS = new Set([
	"bootstrap",
	"deactivate",
	"activate",
	TOKEN_ROTATION_COMMAND,
	REVIEW_MODE_COMMAND,
]);
const COMMANDS = new Set([
	...MUTATING_COMMANDS,
	"assert-room-discovery",
	"status",
]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;

class HotelRunnerEnvGateError extends Error {
	constructor(message, code = "HOTELRUNNER_ENV_GATE_ERROR") {
		super(message);
		this.name = "HotelRunnerEnvGateError";
		this.code = code;
	}
}

const clean = (value) => String(value == null ? "" : value).trim();
const hasOwn = (object, key) =>
	Object.prototype.hasOwnProperty.call(object || {}, key);

const fail = (message, code) => {
	throw new HotelRunnerEnvGateError(message, code);
};

const parseExplicitBoolean = (env, key, { required = false } = {}) => {
	if (!hasOwn(env, key)) {
		if (required) {
			fail(`${key} must be explicitly configured.`, "MISSING_BOOLEAN_GATE");
		}
		return { configured: false, enabled: false };
	}
	const normalized = clean(env[key]).toLowerCase();
	if (TRUE_VALUES.has(normalized)) return { configured: true, enabled: true };
	if (FALSE_VALUES.has(normalized)) return { configured: true, enabled: false };
	fail(`${key} must be an explicit boolean.`, "INVALID_BOOLEAN_GATE");
};

const envLineKey = (line) => {
	const match = String(line).match(
		/^\uFEFF?\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/
	);
	return match ? match[1] : "";
};

const assertUniqueHotelRunnerKeys = (sourceText) => {
	const seen = new Set();
	for (const line of String(sourceText).split(/\r\n|\n/)) {
		const key = envLineKey(line);
		if (!key.startsWith("HOTELRUNNER_")) continue;
		if (seen.has(key)) {
			fail(
				`The explicit env file contains duplicate ${key} entries.`,
				"DUPLICATE_HOTELRUNNER_KEY"
			);
		}
		seen.add(key);
	}
};

const renderEnvUpdate = (sourceText, changes) => {
	const text = String(sourceText);
	const newline = text.includes("\r\n") ? "\r\n" : "\n";
	const hadTrailingNewline = /(?:\r\n|\n)$/.test(text);
	const lines = text ? text.split(/\r\n|\n/) : [];
	if (hadTrailingNewline && lines[lines.length - 1] === "") lines.pop();
	const seen = new Set();
	const updated = lines.map((line) => {
		const key = envLineKey(line);
		if (!hasOwn(changes, key)) return line;
		seen.add(key);
		return `${key}=${changes[key]}`;
	});
	for (const [key, value] of Object.entries(changes)) {
		if (!seen.has(key)) updated.push(`${key}=${value}`);
	}
	return `${updated.join(newline)}${hadTrailingNewline ? newline : ""}`;
};

const regularFileSnapshot = (stat) => ({
	dev: stat.dev,
	ino: stat.ino,
	size: stat.size,
	mtimeMs: stat.mtimeMs,
});

const snapshotsMatch = (left, right) =>
	left.dev === right.dev &&
	left.ino === right.ino &&
	left.size === right.size &&
	left.mtimeMs === right.mtimeMs;

const lstatOrFail = async (targetPath, missingCode) => {
	try {
		return await fs.promises.lstat(targetPath);
	} catch (error) {
		if (error?.code === "ENOENT") {
			fail("The explicitly selected path does not exist.", missingCode);
		}
		throw error;
	}
};

const readExplicitEnvFile = async (envFile) => {
	const resolved = path.resolve(clean(envFile));
	if (!clean(envFile) || resolved === path.parse(resolved).root) {
		fail("A safe explicit --env-file is required.", "ENV_FILE_REQUIRED");
	}
	const pathStat = await lstatOrFail(resolved, "ENV_FILE_NOT_FOUND");
	if (pathStat.isSymbolicLink()) {
		fail("The explicit env file cannot be a symbolic link.", "ENV_FILE_SYMLINK");
	}
	if (!pathStat.isFile()) {
		fail("The explicit env path must be a regular file.", "ENV_FILE_NOT_REGULAR");
	}

	const flags =
		process.platform === "win32"
			? fs.constants.O_RDONLY
			: fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
	const handle = await fs.promises.open(resolved, flags);
	try {
		const openedStat = await handle.stat();
		if (!openedStat.isFile()) {
			fail("The explicit env path must be a regular file.", "ENV_FILE_NOT_REGULAR");
		}
		if (
			pathStat.dev !== openedStat.dev ||
			pathStat.ino !== openedStat.ino
		) {
			fail("The explicit env file changed while it was opened.", "ENV_FILE_RACE");
		}
		return {
			path: resolved,
			buffer: await handle.readFile(),
			snapshot: regularFileSnapshot(openedStat),
		};
	} finally {
		await handle.close();
	}
};

const validateBackupDirectory = async (backupDir, envPath) => {
	const selected = clean(backupDir) || path.dirname(envPath);
	const resolved = path.resolve(selected);
	if (resolved === path.parse(resolved).root) {
		fail("The backup directory cannot be a filesystem root.", "UNSAFE_BACKUP_DIR");
	}
	const stat = await lstatOrFail(resolved, "BACKUP_DIR_NOT_FOUND");
	if (stat.isSymbolicLink()) {
		fail("The backup directory cannot be a symbolic link.", "BACKUP_DIR_SYMLINK");
	}
	if (!stat.isDirectory()) {
		fail("The backup path must be a directory.", "BACKUP_DIR_NOT_DIRECTORY");
	}
	return resolved;
};

const syncDirectory = async (directory) => {
	if (process.platform === "win32") return;
	let handle;
	try {
		handle = await fs.promises.open(directory, fs.constants.O_RDONLY);
		await handle.sync();
	} catch (_error) {
		// Some filesystems do not support directory fsync. The file itself is
		// always synced before rename.
	} finally {
		if (handle) await handle.close();
	}
};

const assertTargetUnchanged = async (targetPath, expectedSnapshot) => {
	const stat = await lstatOrFail(targetPath, "ENV_FILE_NOT_FOUND");
	if (stat.isSymbolicLink()) {
		fail("The explicit env file became a symbolic link.", "ENV_FILE_SYMLINK");
	}
	if (!stat.isFile()) {
		fail("The explicit env path is no longer a regular file.", "ENV_FILE_NOT_REGULAR");
	}
	if (!snapshotsMatch(regularFileSnapshot(stat), expectedSnapshot)) {
		fail("The explicit env file changed during the operation.", "ENV_FILE_RACE");
	}
};

const atomicWrite = async (
	targetPath,
	data,
	{ expectedSnapshot = null } = {}
) => {
	const directory = path.dirname(targetPath);
	const temporaryPath = path.join(
		directory,
		`.hotelrunner-env-gate.v${TOOL_VERSION}.${process.pid}.${crypto
			.randomBytes(12)
			.toString("hex")}.tmp`
	);
	let handle;
	try {
		handle = await fs.promises.open(temporaryPath, "wx", 0o600);
		await handle.writeFile(data);
		if (process.platform !== "win32") await handle.chmod(0o600);
		await handle.sync();
		await handle.close();
		handle = null;
		if (expectedSnapshot) {
			await assertTargetUnchanged(targetPath, expectedSnapshot);
		}
		await fs.promises.rename(temporaryPath, targetPath);
		if (process.platform !== "win32") await fs.promises.chmod(targetPath, 0o600);
		await syncDirectory(directory);
	} catch (error) {
		if (handle) {
			try {
				await handle.close();
			} catch (_closeError) {
				// Preserve the original failure.
			}
		}
		try {
			await fs.promises.unlink(temporaryPath);
		} catch (_unlinkError) {
			// The temporary path may already have been renamed or removed.
		}
		throw error;
	}
};

const createAtomicBackup = async (envRecord, backupDir) => {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const backupName = `${path.basename(envRecord.path)}.hotelrunner-env-gate.v${TOOL_VERSION}.${timestamp}.${crypto
		.randomBytes(6)
		.toString("hex")}.bak`;
	const backupPath = path.join(backupDir, backupName);
	await atomicWrite(backupPath, envRecord.buffer);
	return backupPath;
};

const normalizeTokenInput = (value) => {
	const token = String(value == null ? "" : value).replace(/\r?\n$/, "");
	if (
		token.length < 16 ||
		token.length > 4096 ||
		/[\r\n\0]/.test(token) ||
		/\s/.test(token) ||
		token !== token.trim()
	) {
		fail(
			"The replacement token supplied on standard input is invalid.",
			"INVALID_TOKEN_INPUT"
		);
	}
	return token;
};

const mutationChanges = (command, notBefore, secretInput, enabled) => {
	if (command === REVIEW_MODE_COMMAND) {
		const reviewMode = parseExplicitBoolean(
			{ [REVIEW_MODE_KEY]: enabled },
			REVIEW_MODE_KEY,
			{ required: true }
		);
		return { [REVIEW_MODE_KEY]: reviewMode.enabled ? "true" : "false" };
	}
	const changes = Object.fromEntries(GATE_KEYS.map((key) => [key, "false"]));
	changes[CUTOFF_KEY] = "";
	if (command === TOKEN_ROTATION_COMMAND) {
		changes.HOTELRUNNER_API_TOKEN = normalizeTokenInput(secretInput);
	}
	if (command === "activate") {
		const parsed = parseIsoTimestamp(notBefore);
		if (!parsed) {
			fail(
				"--not-before must be a timezone-qualified ISO timestamp.",
				"INVALID_ACTIVATION_CUTOFF"
			);
		}
		changes.HOTELRUNNER_PROJECTION_ENABLED = "true";
		changes.HOTELRUNNER_ROOM_LIST_SYNC_ENABLED = "true";
		changes[CUTOFF_KEY] = clean(notBefore);
	}
	return changes;
};

const parseFileEnv = (buffer) => dotenv.parse(buffer);

const assertRenderedChangesRoundTrip = (renderedText, changes) => {
	assertUniqueHotelRunnerKeys(renderedText);
	const reparsed = parseFileEnv(Buffer.from(renderedText, "utf8"));
	for (const [key, value] of Object.entries(changes)) {
		if (!hasOwn(reparsed, key) || String(reparsed[key]) !== String(value)) {
			fail(
				`The rendered environment did not preserve ${key}.`,
				"ENV_RENDER_ROUNDTRIP_FAILED"
			);
		}
	}
};

const normalizeComparableValue = (key, value, { configured = true } = {}) => {
	if (GATE_KEYS.includes(key) || key === REVIEW_MODE_KEY) {
		if (!configured) return false;
		return parseExplicitBoolean({ [key]: value }, key, { required: true }).enabled;
	}
	if (key === CUTOFF_KEY) {
		const text = clean(value);
		if (!text) return "";
		const parsed = parseIsoTimestamp(text);
		if (!parsed) fail(`${CUTOFF_KEY} is invalid.`, "INVALID_ACTIVATION_CUTOFF");
		return parsed.toISOString();
	}
	if (key === SUPPORTED_HOTELS_KEY) {
		return parseSupportedHotelIds(value).join(",");
	}
	return clean(value);
};

const assertNoInheritedConflicts = (fileEnv, inheritedEnv) => {
	const hotelRunnerKeys = new Set([
		...ASSERTION_KEYS,
		...Object.keys(fileEnv || {}).filter((key) => key.startsWith("HOTELRUNNER_")),
		...Object.keys(inheritedEnv || {}).filter((key) =>
			key.startsWith("HOTELRUNNER_")
		),
	]);
	for (const key of hotelRunnerKeys) {
		if (!hasOwn(inheritedEnv, key)) continue;
		const fileConfigured = hasOwn(fileEnv, key);
		const fileValue = normalizeComparableValue(key, fileEnv[key], {
			configured: fileConfigured,
		});
		const inheritedValue = normalizeComparableValue(key, inheritedEnv[key], {
			configured: true,
		});
		if (fileValue !== inheritedValue) {
			fail(
				`Inherited ${key} conflicts with the explicit env file.`,
				"INHERITED_ENV_CONFLICT"
			);
		}
	}
};

const buildStatus = (fileEnv) => {
	const settings = {};
	for (const key of GATE_KEYS) {
		const parsed = parseExplicitBoolean(fileEnv, key);
		settings[key] = {
			configured: parsed.configured,
			enabled: parsed.enabled,
		};
	}
	const reviewMode = parseExplicitBoolean(fileEnv, REVIEW_MODE_KEY);
	settings[REVIEW_MODE_KEY] = {
		configured: reviewMode.configured,
		enabled: reviewMode.enabled,
	};
	const cutoffText = clean(fileEnv[CUTOFF_KEY]);
	settings[CUTOFF_KEY] = {
		configured: Boolean(cutoffText),
		valid: !cutoffText || Boolean(parseIsoTimestamp(cutoffText)),
	};
	for (const key of CREDENTIAL_KEYS) {
		settings[key] = { configured: Boolean(clean(fileEnv[key])) };
	}
	const supportedIds = parseSupportedHotelIds(fileEnv[SUPPORTED_HOTELS_KEY]);
	settings[SUPPORTED_HOTELS_KEY] = {
		configured: Boolean(clean(fileEnv[SUPPORTED_HOTELS_KEY])),
		exactlyOne: supportedIds.length === 1,
		valid: supportedIds.length === 1 && OBJECT_ID_PATTERN.test(supportedIds[0]),
	};
	return {
		schemaVersion: TOOL_VERSION,
		command: "status",
		settings,
	};
};

const assertRoomDiscovery = (fileEnv, inheritedEnv = {}) => {
	for (const key of GATE_KEYS) {
		const gate = parseExplicitBoolean(fileEnv, key, { required: true });
		if (gate.enabled) {
			fail(`${key} must be false for room discovery.`, "ROOM_DISCOVERY_GATE_OPEN");
		}
	}
	for (const key of CREDENTIAL_KEYS) {
		if (!clean(fileEnv[key])) {
			fail(`${key} must be configured.`, "ROOM_DISCOVERY_CREDENTIAL_MISSING");
		}
	}
	const supportedIds = parseSupportedHotelIds(fileEnv[SUPPORTED_HOTELS_KEY]);
	if (supportedIds.length !== 1 || !OBJECT_ID_PATTERN.test(supportedIds[0])) {
		fail(
			`${SUPPORTED_HOTELS_KEY} must contain exactly one valid local hotel ID.`,
			"ROOM_DISCOVERY_HOTEL_SCOPE_INVALID"
		);
	}
	assertNoInheritedConflicts(fileEnv, inheritedEnv);
	return {
		schemaVersion: TOOL_VERSION,
		command: "assert-room-discovery",
		ready: true,
	};
};

const runEnvGateCommand = async ({
	command,
	envFile,
	backupDir = "",
	notBefore = "",
	enabled = "",
	secretInput,
	inheritedEnv = process.env,
} = {}) => {
	if (!COMMANDS.has(command)) {
		fail("A supported command is required.", "INVALID_COMMAND");
	}
	if (!clean(envFile)) {
		fail("An explicit --env-file is required.", "ENV_FILE_REQUIRED");
	}
	if (command !== "activate" && clean(notBefore)) {
		fail("--not-before is only valid with activate.", "INVALID_ARGUMENT");
	}
	if (command !== REVIEW_MODE_COMMAND && clean(enabled)) {
		fail("--enabled is only valid with set-review-mode.", "INVALID_ARGUMENT");
	}
	if (command === REVIEW_MODE_COMMAND && !clean(enabled)) {
		fail("set-review-mode requires --enabled.", "REVIEW_MODE_VALUE_REQUIRED");
	}
	if (!MUTATING_COMMANDS.has(command) && clean(backupDir)) {
		fail("--backup-dir is only valid for mutations.", "INVALID_ARGUMENT");
	}
	const envRecord = await readExplicitEnvFile(envFile);
	assertUniqueHotelRunnerKeys(envRecord.buffer.toString("utf8"));
	const fileEnv = parseFileEnv(envRecord.buffer);

	if (command === "status") {
		assertNoInheritedConflicts(fileEnv, inheritedEnv);
		return buildStatus(fileEnv);
	}
	if (command === "assert-room-discovery") {
		return assertRoomDiscovery(fileEnv, inheritedEnv);
	}

	if (command === TOKEN_ROTATION_COMMAND) {
		for (const key of GATE_KEYS) {
			const gate = parseExplicitBoolean(fileEnv, key, { required: true });
			if (gate.enabled) {
				fail(
					`${key} must be false before rotating credentials.`,
					"TOKEN_ROTATION_GATE_OPEN"
				);
			}
		}
		if (clean(fileEnv[CUTOFF_KEY])) {
			fail(
				`${CUTOFF_KEY} must be blank before rotating credentials.`,
				"TOKEN_ROTATION_CUTOFF_SET"
			);
		}
		if (!clean(fileEnv.HOTELRUNNER_API_HR_ID)) {
			fail(
				"HOTELRUNNER_API_HR_ID must already be configured before rotating the token.",
				"TOKEN_ROTATION_HR_ID_MISSING"
			);
		}
		const supportedIds = parseSupportedHotelIds(
			fileEnv[SUPPORTED_HOTELS_KEY]
		);
		if (
			supportedIds.length !== 1 ||
			!OBJECT_ID_PATTERN.test(supportedIds[0])
		) {
			fail(
				`${SUPPORTED_HOTELS_KEY} must contain exactly one valid local hotel ID before rotating the token.`,
				"TOKEN_ROTATION_HOTEL_SCOPE_INVALID"
			);
		}
	}
	const changes = mutationChanges(command, notBefore, secretInput, enabled);
	if (
		command === TOKEN_ROTATION_COMMAND &&
		clean(fileEnv.HOTELRUNNER_API_TOKEN) === changes.HOTELRUNNER_API_TOKEN
	) {
		fail(
			"The replacement token must differ from the current token.",
			"TOKEN_UNCHANGED"
		);
	}
	const proposedEnv = { ...fileEnv, ...changes };
	// A file-only mutation cannot neutralize an exported shell/PM2 value because
	// inherited variables take precedence over dotenv. Refuse to report success
	// unless every inherited HotelRunner value agrees with the post-change file.
	assertNoInheritedConflicts(proposedEnv, inheritedEnv);
	const updated = renderEnvUpdate(envRecord.buffer.toString("utf8"), changes);
	assertRenderedChangesRoundTrip(updated, changes);
	const safeBackupDir = await validateBackupDirectory(backupDir, envRecord.path);
	const backupPath = await createAtomicBackup(envRecord, safeBackupDir);
	await atomicWrite(envRecord.path, updated, {
		expectedSnapshot: envRecord.snapshot,
	});
	return {
		schemaVersion: TOOL_VERSION,
		command,
		backupCreated: Boolean(backupPath),
		changedKeys: Object.keys(changes),
	};
};

const parseCliArguments = (argv) => {
	const args = [...argv];
	const command = args.shift() || "";
	const options = {
		command,
		envFile: "",
		backupDir: "",
		notBefore: "",
		enabled: "",
	};
	const seen = new Set();
	while (args.length) {
		const flag = args.shift();
		if (
			!["--env-file", "--backup-dir", "--not-before", "--enabled"].includes(
				flag
			)
		) {
			fail("An unsupported command-line option was provided.", "INVALID_ARGUMENT");
		}
		if (seen.has(flag)) {
			fail("A command-line option was provided more than once.", "INVALID_ARGUMENT");
		}
		seen.add(flag);
		if (!args.length || String(args[0]).startsWith("--")) {
			fail(`${flag} requires an explicit argument.`, "INVALID_ARGUMENT");
		}
		const value = args.shift();
		if (flag === "--env-file") options.envFile = value;
		if (flag === "--backup-dir") options.backupDir = value;
		if (flag === "--not-before") options.notBefore = value;
		if (flag === "--enabled") options.enabled = value;
	}
	if (!COMMANDS.has(command)) {
		fail("A supported command is required.", "INVALID_COMMAND");
	}
	if (!options.envFile) {
		fail("An explicit --env-file is required.", "ENV_FILE_REQUIRED");
	}
	if (command === "activate" && !options.notBefore) {
		fail("activate requires --not-before.", "ACTIVATION_CUTOFF_REQUIRED");
	}
	if (command !== "activate" && options.notBefore) {
		fail("--not-before is only valid with activate.", "INVALID_ARGUMENT");
	}
	if (command === REVIEW_MODE_COMMAND && !options.enabled) {
		fail("set-review-mode requires --enabled.", "REVIEW_MODE_VALUE_REQUIRED");
	}
	if (command !== REVIEW_MODE_COMMAND && options.enabled) {
		fail("--enabled is only valid with set-review-mode.", "INVALID_ARGUMENT");
	}
	if (!MUTATING_COMMANDS.has(command) && options.backupDir) {
		fail("--backup-dir is only valid for mutations.", "INVALID_ARGUMENT");
	}
	return options;
};

const safeCliError = (error) => {
	if (error instanceof HotelRunnerEnvGateError) {
		return `${error.code}: ${error.message}`;
	}
	return `OPERATION_FAILED: ${clean(error?.code) || "UNKNOWN"}`;
};

const main = async () => {
	try {
		const options = parseCliArguments(process.argv.slice(2));
		if (options.command === TOKEN_ROTATION_COMMAND) {
			if (process.stdin.isTTY) {
				fail(
					"rotate-token requires the replacement token on standard input.",
					"TOKEN_STDIN_REQUIRED"
				);
			}
			options.secretInput = fs.readFileSync(0, "utf8");
		}
		const result = await runEnvGateCommand(options);
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	} catch (error) {
		process.stderr.write(`HotelRunner env gate failed: ${safeCliError(error)}\n`);
		process.exitCode = 1;
	}
};

if (require.main === module) main();

module.exports = {
	ASSERTION_KEYS,
	CREDENTIAL_KEYS,
	CUTOFF_KEY,
	GATE_KEYS,
	HotelRunnerEnvGateError,
	REVIEW_MODE_COMMAND,
	REVIEW_MODE_KEY,
	SUPPORTED_HOTELS_KEY,
	TOKEN_ROTATION_COMMAND,
	TOOL_VERSION,
	assertNoInheritedConflicts,
	assertRenderedChangesRoundTrip,
	assertRoomDiscovery,
	assertUniqueHotelRunnerKeys,
	atomicWrite,
	buildStatus,
	mutationChanges,
	normalizeTokenInput,
	parseCliArguments,
	parseExplicitBoolean,
	readExplicitEnvFile,
	renderEnvUpdate,
	runEnvGateCommand,
};
