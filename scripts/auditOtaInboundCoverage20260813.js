#!/usr/bin/env node
/** @format */

"use strict";

require("dotenv").config();

const mongoose = require("mongoose");
const InboundEmail = require("../models/inbound_email");
const Reservations = require("../models/reservations");
const {
	ARCHIVE_START,
	auditOtaInboundCoverage,
} = require("../services/otaInboundCoverageAudit20260813");

const HELP = [
	"Read-only OTA inbound email-to-reservation coverage audit.",
	"",
	"Usage:",
	"  node scripts/auditOtaInboundCoverage20260813.js [--as-of=<ISO>] [--since=<ISO>]",
	"",
	"Exit codes:",
	"  0  No active/nonterminal missing identities",
	"  1  Audit could not complete safely",
	"  2  One or more active/nonterminal identities have no Reservation",
	"",
	`The comprehensive default window begins ${ARCHIVE_START.toISOString()}.`,
].join("\n");

function parseDateArgument(value, name) {
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) {
		throw new TypeError(`${name} must be a valid ISO date.`);
	}
	return date;
}

function parseArgs(argv = []) {
	const options = { since: new Date(ARCHIVE_START), asOf: new Date() };
	for (const argument of argv) {
		if (argument === "--help" || argument === "-h") {
			options.help = true;
			continue;
		}
		if (argument.startsWith("--as-of=")) {
			options.asOf = parseDateArgument(argument.slice("--as-of=".length), "as-of");
			continue;
		}
		if (argument.startsWith("--since=")) {
			options.since = parseDateArgument(argument.slice("--since=".length), "since");
			continue;
		}
		throw new TypeError(`Unsupported argument: ${argument}`);
	}
	if (options.since > options.asOf) {
		throw new RangeError("since cannot be after as-of.");
	}
	return options;
}

function exitCodeForReport(report = {}) {
	return report?.alert?.active === true ? 2 : 0;
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
	const options = parseArgs(argv);
	if (options.help) {
		process.stdout.write(`${HELP}\n`);
		return 0;
	}
	const database =
		dependencies.database ||
		process.env.DATABASE ||
		process.env.MONGO_URI ||
		process.env.MONGODB_URI;
	if (!database && !dependencies.skipConnect) {
		const error = new Error("Database configuration is required.");
		error.code = "OTA_COVERAGE_DATABASE_REQUIRED";
		throw error;
	}
	const connect = dependencies.connect || mongoose.connect.bind(mongoose);
	const disconnect =
		dependencies.disconnect || mongoose.disconnect.bind(mongoose);
	try {
		if (!dependencies.skipConnect) {
			await connect(database, { autoIndex: false, autoCreate: false });
		}
		const report = await (dependencies.audit || auditOtaInboundCoverage)({
			InboundEmailModel: dependencies.InboundEmailModel || InboundEmail,
			ReservationModel: dependencies.ReservationModel || Reservations,
			since: options.since,
			asOf: options.asOf,
		});
		(dependencies.write || process.stdout.write.bind(process.stdout))(
			`${JSON.stringify(report, null, 2)}\n`
		);
		return exitCodeForReport(report);
	} finally {
		if (!dependencies.skipConnect && mongoose.connection.readyState !== 0) {
			await disconnect();
		}
	}
}

if (require.main === module) {
	main()
		.then((exitCode) => {
			process.exitCode = exitCode;
		})
		.catch((error) => {
			const safeCode = String(error?.code || error?.name || "OTA_COVERAGE_AUDIT_FAILED")
				.replace(/[^A-Za-z0-9_-]/g, "")
				.slice(0, 80);
			process.stderr.write(`OTA inbound coverage audit failed (${safeCode}).\n`);
			process.exitCode = 1;
		});
}

module.exports = { HELP, exitCodeForReport, main, parseArgs };
