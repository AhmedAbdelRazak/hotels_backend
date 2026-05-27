#!/usr/bin/env node
/** @format */

require("dotenv").config();

const { ImapFlow } = require("imapflow");
const fetch = require("node-fetch");
const { simpleParser } = require("mailparser");

const env = (names, fallback = "") => {
	const list = Array.isArray(names) ? names : [names];
	for (const name of list) {
		const value = process.env[name];
		if (value !== undefined && value !== null && String(value).trim() !== "") {
			return String(value).trim();
		}
	}
	return fallback;
};

const boolEnv = (name, fallback = false) => {
	const value = process.env[name];
	if (value === undefined || value === null || value === "") return fallback;
	return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
};

const numberEnv = (name, fallback) => {
	const parsed = Number(process.env[name]);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const getConfig = () => ({
	host: env(["OTA_MAILBOX_HOST", "IMAP_HOST"]),
	port: numberEnv("OTA_MAILBOX_PORT", numberEnv("IMAP_PORT", 993)),
	secure: boolEnv("OTA_MAILBOX_SECURE", boolEnv("IMAP_SECURE", true)),
	user: env(["OTA_MAILBOX_USER", "IMAP_USER"]),
	pass: env(["OTA_MAILBOX_PASS", "IMAP_PASS"]),
	folder: env("OTA_MAILBOX_FOLDER", "INBOX"),
	postUrl: env(
		["OTA_INBOUND_POST_URL", "OTA_INBOUND_EMAIL_URL"],
		"http://127.0.0.1:8080/api/ota/inbound/email"
	),
	secret: env(["OTA_INBOUND_EMAIL_SECRET", "INBOUND_EMAIL_SECRET"]),
	allowMissingSecret: boolEnv("OTA_INBOUND_ALLOW_MISSING_SECRET", false),
	markSeenAfterSuccess: boolEnv("OTA_MAILBOX_SEEN_AFTER_SUCCESS", true),
	maxPerPoll: numberEnv("OTA_MAILBOX_MAX_PER_POLL", 25),
	pollIntervalMs: numberEnv("OTA_MAILBOX_POLL_INTERVAL_MS", 60000),
	dryRun: boolEnv("OTA_MAILBOX_DRY_RUN", false),
});

const redact = (value = "") => (value ? `${String(value).slice(0, 3)}***` : "");

const validateConfig = (config) => {
	const missing = [];
	if (!config.host) missing.push("OTA_MAILBOX_HOST");
	if (!config.user) missing.push("OTA_MAILBOX_USER");
	if (!config.pass) missing.push("OTA_MAILBOX_PASS");
	if (!config.postUrl) missing.push("OTA_INBOUND_POST_URL");
	if (!config.secret && !config.allowMissingSecret) {
		missing.push("OTA_INBOUND_EMAIL_SECRET");
	}
	const placeholders = [];
	const placeholderPattern = /^<.*>$|password|credential|long\s+secret|secret\s+here|change\s+me/i;
	if (config.pass && placeholderPattern.test(config.pass)) {
		placeholders.push("OTA_MAILBOX_PASS");
	}
	if (
		config.secret &&
		!config.allowMissingSecret &&
		(placeholderPattern.test(config.secret) || config.secret.length < 24)
	) {
		placeholders.push("OTA_INBOUND_EMAIL_SECRET");
	}
	if (placeholders.length) {
		missing.push(
			`replace placeholder/weak value(s): ${placeholders.join(", ")}`
		);
	}
	return missing;
};

const diagnostics = (config) => ({
	host: config.host,
	port: config.port,
	secure: config.secure,
	user: redact(config.user),
	folder: config.folder,
	postUrl: config.postUrl,
	hasSecret: !!config.secret,
	markSeenAfterSuccess: config.markSeenAfterSuccess,
	maxPerPoll: config.maxPerPoll,
	pollIntervalMs: config.pollIntervalMs,
	dryRun: config.dryRun,
});

const buildClient = (config) =>
	new ImapFlow({
		host: config.host,
		port: config.port,
		secure: config.secure,
		auth: {
			user: config.user,
			pass: config.pass,
		},
		logger: false,
	});

const parseForLog = async (source) => {
	try {
		const parsed = await simpleParser(source);
		return {
			from: parsed.from?.text || "",
			subject: parsed.subject || "",
			messageId: parsed.messageId || "",
		};
	} catch (error) {
		return { from: "", subject: "", messageId: "", parseError: error.message };
	}
};

const postInboundEmail = async (config, source) => {
	if (config.dryRun) {
		return { ok: true, status: 204, body: "dry-run" };
	}

	const response = await fetch(config.postUrl, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-inbound-secret": config.secret,
		},
		body: JSON.stringify({ raw: source.toString("utf8") }),
	});
	const body = await response.text();
	return { ok: response.ok, status: response.status, body };
};

const processMailbox = async (config) => {
	const missing = validateConfig(config);
	if (missing.length) {
		throw new Error(`Missing required mailbox configuration: ${missing.join(", ")}`);
	}

	const client = buildClient(config);
	await client.connect();
	const lock = await client.getMailboxLock(config.folder);

	let processed = 0;
	let succeeded = 0;
	let failed = 0;

	try {
		const uids = (await client.search({ seen: false }, { uid: true })) || [];
		const selectedUids = uids.slice(0, config.maxPerPoll);
		if (!selectedUids.length) {
			console.log("[ota-mailbox] no unseen messages");
			return { processed, succeeded, failed };
		}

		for await (const message of client.fetch(
			selectedUids,
			{ source: true, envelope: true, flags: true, uid: true },
			{ uid: true }
		)) {
			processed += 1;
			const source = message.source || Buffer.from("");
			const logFields = await parseForLog(source);
			console.log("[ota-mailbox] forwarding", {
				uid: message.uid,
				subject: logFields.subject || message.envelope?.subject || "",
				from: logFields.from,
				messageId: logFields.messageId,
			});

			try {
				const result = await postInboundEmail(config, source);
				if (!result.ok) {
					failed += 1;
					console.error("[ota-mailbox] inbound post failed", {
						uid: message.uid,
						status: result.status,
						body: String(result.body || "").slice(0, 500),
					});
					continue;
				}

				succeeded += 1;
				if (config.markSeenAfterSuccess && !config.dryRun) {
					await client.messageFlagsAdd(message.uid, ["\\Seen"], { uid: true });
				}
			} catch (error) {
				failed += 1;
				console.error("[ota-mailbox] message failed", {
					uid: message.uid,
					error: error.message,
				});
			}
		}
	} finally {
		lock.release();
		await client.logout().catch(() => {});
	}

	return { processed, succeeded, failed };
};

const runOnce = async () => {
	const config = getConfig();
	console.log("[ota-mailbox] starting poll", diagnostics(config));
	const result = await processMailbox(config);
	console.log("[ota-mailbox] poll complete", result);
	return result;
};

const main = async () => {
	const config = getConfig();

	if (process.argv.includes("--check-config")) {
		const missing = validateConfig(config);
		console.log("[ota-mailbox] config", {
			ok: missing.length === 0,
			missing,
			...diagnostics(config),
		});
		process.exit(missing.length ? 1 : 0);
	}

	const once = process.argv.includes("--once") || boolEnv("OTA_MAILBOX_ONCE", false);
	if (once) {
		await runOnce();
		return;
	}

	let running = false;
	const guardedRun = async () => {
		if (running) {
			console.warn("[ota-mailbox] previous poll still running; skipping overlap");
			return;
		}
		running = true;
		try {
			await runOnce();
		} catch (error) {
			console.error("[ota-mailbox] poll failed", error.message);
		} finally {
			running = false;
		}
	};

	await guardedRun();
	setInterval(() => {
		guardedRun();
	}, config.pollIntervalMs);
};

if (require.main === module) {
	main().catch((error) => {
		console.error("[ota-mailbox] fatal", error.message);
		process.exit(1);
	});
}

module.exports = {
	getConfig,
	validateConfig,
	processMailbox,
	postInboundEmail,
};
