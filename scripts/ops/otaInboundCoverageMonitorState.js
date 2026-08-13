#!/usr/bin/env node
/** @format */

"use strict";

const fs = require("fs");
const path = require("path");

const STATE_SCHEMA_VERSION = 1;

const clean = (value) => String(value ?? "").trim();

function parseArgs(argv = []) {
	const options = {};
	for (const argument of argv) {
		const separator = argument.indexOf("=");
		if (!argument.startsWith("--") || separator < 3) {
			throw new TypeError("Monitor-state arguments must use --name=value.");
		}
		const key = argument.slice(2, separator);
		const value = argument.slice(separator + 1);
		if (
			![
				"audit-exit",
				"error-code",
				"mode",
				"report-file",
				"state-file",
			].includes(key)
		) {
			throw new TypeError(`Unsupported monitor-state argument: ${key}`);
		}
		options[key] = value;
	}
	return options;
}

function nonnegativeInteger(value, label) {
	const number = Number(value ?? 0);
	if (!Number.isSafeInteger(number) || number < 0) {
		throw new TypeError(`${label} must be a nonnegative safe integer.`);
	}
	return number;
}

function safeCounts(value = {}) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return Object.fromEntries(
		Object.entries(value)
			.map(([key, count]) => [
				clean(key).replace(/[^a-z0-9_.-]/gi, "_").slice(0, 80),
				nonnegativeInteger(count, "count"),
			])
			.filter(([key]) => key)
			.sort(([left], [right]) => left.localeCompare(right))
	);
}

function activeCountsBy(items = [], field = "reason") {
	const counts = {};
	for (const item of Array.isArray(items) ? items : []) {
		if (item?.status !== "active_nonterminal") continue;
		const key = clean(item?.[field]).toLowerCase();
		if (!key) continue;
		counts[key] = Number(counts[key] || 0) + 1;
	}
	return safeCounts(counts);
}

function validateFingerprint(value) {
	const fingerprint = clean(value).toLowerCase();
	if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
		throw new TypeError("The coverage report has no valid alert fingerprint.");
	}
	return fingerprint;
}

function transitionFor(previous = null, current = {}) {
	if (current.status === "error") return "audit_error";
	if (current.status === "alert") {
		if (previous?.status !== "alert") return "alert_new";
		return previous.alertFingerprint === current.alertFingerprint
			? "alert_unchanged"
			: "alert_changed";
	}
	return previous?.status === "alert" || previous?.status === "error"
		? "resolved"
		: "clean_unchanged";
}

function buildMonitorState({
	report = null,
	auditExitCode = 1,
	mode = "recent",
	errorCode = "",
	previous = null,
} = {}) {
	const normalizedMode = clean(mode).toLowerCase();
	if (!["recent", "full"].includes(normalizedMode)) {
		throw new TypeError("mode must be recent or full.");
	}
	const exitCode = Number(auditExitCode);
	if (![0, 1, 2].includes(exitCode)) {
		throw new TypeError("auditExitCode must be 0, 1, or 2.");
	}

	let state;
	if (exitCode === 1) {
		const requestedErrorCode = clean(errorCode).toLowerCase();
		const safeErrorCode = /^(?:audit_timeout|audit_exit_[0-9]{1,3}|coverage_audit_failed)$/.test(
			requestedErrorCode
		)
			? requestedErrorCode
			: "coverage_audit_failed";
		state = {
			schemaVersion: STATE_SCHEMA_VERSION,
			mode: normalizedMode,
			status: "error",
			checkedAt: new Date().toISOString(),
			auditExitCode: 1,
			errorCode: safeErrorCode,
			alertFingerprint: "",
			activeIdentityCount: 0,
			incompletePipelineArchiveCount: 0,
			activeIssueCount: 0,
			activeReasonCounts: {},
			activeProviderCounts: {},
			pipelineReasonCounts: {},
			integrityFlagIdentityCount: 0,
			integrityFlagCounts: {},
			queryStats: {},
		};
	} else {
		if (
			report?.readOnly !== true ||
			report?.vendorCalls !== false ||
			report?.alert?.active !== (exitCode === 2)
		) {
			throw new TypeError("Coverage report safety or exit semantics are invalid.");
		}
		const checkedAt = new Date(report?.window?.asOf || "");
		if (!Number.isFinite(checkedAt.getTime())) {
			throw new TypeError("Coverage report as-of time is invalid.");
		}
		state = {
			schemaVersion: STATE_SCHEMA_VERSION,
			mode: normalizedMode,
			status: exitCode === 2 ? "alert" : "clean",
			checkedAt: checkedAt.toISOString(),
			auditExitCode: exitCode,
			errorCode: "",
			alertFingerprint: validateFingerprint(
				report.alertFingerprint || report?.alert?.fingerprint
			),
			activeIdentityCount: nonnegativeInteger(
				report?.alert?.activeIdentityCount,
				"activeIdentityCount"
			),
			incompletePipelineArchiveCount: nonnegativeInteger(
				report?.alert?.incompletePipelineArchiveCount,
				"incompletePipelineArchiveCount"
			),
			activeIssueCount: nonnegativeInteger(
				report?.alert?.activeIssueCount,
				"activeIssueCount"
			),
			activeReasonCounts: activeCountsBy(
				report.missingIdentities,
				"reason"
			),
			activeProviderCounts: activeCountsBy(
				report.missingIdentities,
				"provider"
			),
			pipelineReasonCounts: safeCounts(
				report?.summary?.pipelineReasonCounts
			),
			integrityFlagIdentityCount: nonnegativeInteger(
				report?.summary?.integrityFlagIdentityCount,
				"integrityFlagIdentityCount"
			),
			integrityFlagCounts: safeCounts(
				report?.summary?.integrityFlagCounts
			),
			queryStats: Object.fromEntries(
				[
					"creatingArchivesRead",
					"lifecycleArchivesRead",
					"pipelineArchivesRead",
					"reservationsRead",
					"reservationLookupRowsRead",
					"reservationLookupQueryCount",
				].map((key) => [
					key,
					nonnegativeInteger(report?.queryStats?.[key], key),
				])
			),
		};
	}
	state.transition = transitionFor(previous, state);
	return state;
}

function readPreviousState(stateFile) {
	try {
		return JSON.parse(fs.readFileSync(stateFile, "utf8"));
	} catch {
		return null;
	}
}

function writeStateAtomically(stateFile, state) {
	const directory = path.dirname(stateFile);
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	const temporary = path.join(
		directory,
		`.${path.basename(stateFile)}.${process.pid}.${Date.now()}.tmp`
	);
	try {
		fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
		fs.renameSync(temporary, stateFile);
		fs.chmodSync(stateFile, 0o600);
	} finally {
		try {
			fs.unlinkSync(temporary);
		} catch {
			// The atomic rename normally consumes the temporary path.
		}
	}
}

function main(argv = process.argv.slice(2)) {
	const options = parseArgs(argv);
	const stateFile = path.resolve(clean(options["state-file"]));
	if (!clean(options["state-file"])) {
		throw new TypeError("--state-file is required.");
	}
	const auditExitCode = Number(options["audit-exit"]);
	const previous = readPreviousState(stateFile);
	let report = null;
	if (auditExitCode !== 1) {
		const reportFile = path.resolve(clean(options["report-file"]));
		if (!clean(options["report-file"])) {
			throw new TypeError("--report-file is required for exit 0 or 2.");
		}
		report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
	}
	const state = buildMonitorState({
		report,
		auditExitCode,
		mode: options.mode,
		errorCode: options["error-code"],
		previous,
	});
	writeStateAtomically(stateFile, state);
	if (state.transition !== "alert_unchanged" && state.transition !== "clean_unchanged") {
		process.stdout.write(
			`[ota-coverage-monitor] ${JSON.stringify({
				mode: state.mode,
				status: state.status,
				transition: state.transition,
				checkedAt: state.checkedAt,
				activeIssueCount: state.activeIssueCount,
				fingerprint: state.alertFingerprint.slice(0, 12),
				errorCode: state.errorCode,
			})}\n`
		);
	}
	return state;
}

if (require.main === module) {
	try {
		main();
	} catch (error) {
		const safeCode = clean(error?.code || error?.name || "MONITOR_STATE_FAILED")
			.replace(/[^a-z0-9_-]/gi, "_")
			.slice(0, 80);
		process.stderr.write(
			`OTA coverage monitor state update failed (${safeCode}).\n`
		);
		process.exitCode = 1;
	}
}

module.exports = {
	STATE_SCHEMA_VERSION,
	activeCountsBy,
	buildMonitorState,
	main,
	parseArgs,
	transitionFor,
	writeStateAtomically,
};
