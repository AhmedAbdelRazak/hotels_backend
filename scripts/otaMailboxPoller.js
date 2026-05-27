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

const getConfig = () => {
	const graphTenantId = env(["OTA_GRAPH_TENANT_ID", "MS_GRAPH_TENANT_ID"]);
	const graphClientId = env(["OTA_GRAPH_CLIENT_ID", "MS_GRAPH_CLIENT_ID"]);
	const graphClientSecret = env([
		"OTA_GRAPH_CLIENT_SECRET",
		"MS_GRAPH_CLIENT_SECRET",
	]);
	const provider = env(
		"OTA_MAILBOX_PROVIDER",
		graphTenantId && graphClientId && graphClientSecret ? "graph" : "imap"
	).toLowerCase();

	return {
		provider,
		host: env(["OTA_MAILBOX_HOST", "IMAP_HOST"]),
		port: numberEnv("OTA_MAILBOX_PORT", numberEnv("IMAP_PORT", 993)),
		secure: boolEnv("OTA_MAILBOX_SECURE", boolEnv("IMAP_SECURE", true)),
		user: env(["OTA_MAILBOX_USER", "IMAP_USER", "OTA_GRAPH_MAILBOX_USER"]),
		pass: env(["OTA_MAILBOX_PASS", "IMAP_PASS"]),
		folder: env("OTA_MAILBOX_FOLDER", provider === "graph" ? "inbox" : "INBOX"),
		graphTenantId,
		graphClientId,
		graphClientSecret,
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
	};
};

const redact = (value = "") => (value ? `${String(value).slice(0, 3)}***` : "");

const validateConfig = (config) => {
	const missing = [];
	if (!["imap", "graph"].includes(config.provider)) {
		missing.push("OTA_MAILBOX_PROVIDER must be imap or graph");
	}
	if (!config.user) missing.push("OTA_MAILBOX_USER");
	if (config.provider === "imap") {
		if (!config.host) missing.push("OTA_MAILBOX_HOST");
		if (!config.pass) missing.push("OTA_MAILBOX_PASS");
	}
	if (config.provider === "graph") {
		if (!config.graphTenantId) missing.push("OTA_GRAPH_TENANT_ID");
		if (!config.graphClientId) missing.push("OTA_GRAPH_CLIENT_ID");
		if (!config.graphClientSecret) missing.push("OTA_GRAPH_CLIENT_SECRET");
	}
	if (!config.postUrl) missing.push("OTA_INBOUND_POST_URL");
	if (!config.secret && !config.allowMissingSecret) {
		missing.push("OTA_INBOUND_EMAIL_SECRET");
	}
	const placeholders = [];
	const placeholderPattern = /^<.*>$|password|credential|long\s+secret|secret\s+here|change\s+me/i;
	if (config.provider === "imap" && config.pass && placeholderPattern.test(config.pass)) {
		placeholders.push("OTA_MAILBOX_PASS");
	}
	if (
		config.provider === "graph" &&
		config.graphClientSecret &&
		placeholderPattern.test(config.graphClientSecret)
	) {
		placeholders.push("OTA_GRAPH_CLIENT_SECRET");
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
	provider: config.provider,
	host: config.host,
	port: config.port,
	secure: config.secure,
	user: redact(config.user),
	folder: config.folder,
	graphTenantId: redact(config.graphTenantId),
	hasGraphClientId: !!config.graphClientId,
	postUrl: config.postUrl,
	hasSecret: !!config.secret,
	markSeenAfterSuccess: config.markSeenAfterSuccess,
	maxPerPoll: config.maxPerPoll,
	pollIntervalMs: config.pollIntervalMs,
	dryRun: config.dryRun,
});

const describeError = (error = {}) => ({
	name: error.name || "",
	message: error.message || String(error || ""),
	code: error.code || "",
	response: error.response || "",
	status: error.status || "",
	body: error.body || "",
	serverResponseCode: error.serverResponseCode || "",
	authenticationFailed: !!error.authenticationFailed,
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

const graphToken = async (config) => {
	const params = new URLSearchParams();
	params.set("client_id", config.graphClientId);
	params.set("client_secret", config.graphClientSecret);
	params.set("scope", "https://graph.microsoft.com/.default");
	params.set("grant_type", "client_credentials");

	const response = await fetch(
		`https://login.microsoftonline.com/${encodeURIComponent(
			config.graphTenantId
		)}/oauth2/v2.0/token`,
		{
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: params.toString(),
		}
	);
	const body = await response.json().catch(async () => ({
		error_description: await response.text(),
	}));
	if (!response.ok) {
		const error = new Error(body.error_description || body.error || "Graph token request failed");
		error.status = response.status;
		error.body = JSON.stringify(body).slice(0, 1000);
		throw error;
	}
	return body.access_token;
};

const graphRequest = async (config, path, options = {}) => {
	const token = options.token || (await graphToken(config));
	const response = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
		...options,
		headers: {
			authorization: `Bearer ${token}`,
			...(options.headers || {}),
		},
	});
	if (!response.ok) {
		const body = await response.text();
		const error = new Error(`Graph request failed: ${response.status}`);
		error.status = response.status;
		error.body = body.slice(0, 1000);
		throw error;
	}
	return response;
};

const graphMailboxPath = (config) =>
	`/users/${encodeURIComponent(config.user)}/mailFolders/${encodeURIComponent(
		config.folder || "inbox"
	)}`;

const listGraphUnreadMessages = async (config, token) => {
	const select = "id,subject,from,receivedDateTime,internetMessageId,isRead";
	const path = `${graphMailboxPath(config)}/messages?$filter=isRead eq false&$top=${
		config.maxPerPoll
	}&$select=${encodeURIComponent(select)}`;
	const response = await graphRequest(config, path, { token });
	const body = await response.json();
	return Array.isArray(body.value) ? body.value : [];
};

const graphMessageRaw = async (config, token, messageId) => {
	const response = await graphRequest(
		config,
		`/users/${encodeURIComponent(config.user)}/messages/${encodeURIComponent(
			messageId
		)}/$value`,
		{ token, headers: { accept: "message/rfc822" } }
	);
	return response.buffer();
};

const markGraphMessageRead = async (config, token, messageId) => {
	await graphRequest(
		config,
		`/users/${encodeURIComponent(config.user)}/messages/${encodeURIComponent(
			messageId
		)}`,
		{
			token,
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ isRead: true }),
		}
	);
};

const testConnection = async (config) => {
	const missing = validateConfig(config);
	if (missing.length) {
		throw new Error(`Missing required mailbox configuration: ${missing.join(", ")}`);
	}

	if (config.provider === "graph") {
		const token = await graphToken(config);
		const messages = await listGraphUnreadMessages(config, token);
		return {
			connected: true,
			provider: "graph",
			folder: config.folder,
			unseenCount: messages.length,
		};
	}

	const client = buildClient(config);
	await client.connect();
	const lock = await client.getMailboxLock(config.folder);
	try {
		const unseen = (await client.search({ seen: false }, { uid: true })) || [];
		return {
			connected: true,
			folder: config.folder,
			unseenCount: Array.isArray(unseen) ? unseen.length : 0,
		};
	} finally {
		lock.release();
		await client.logout().catch(() => {});
	}
};

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

const processGraphMailbox = async (config) => {
	const missing = validateConfig(config);
	if (missing.length) {
		throw new Error(`Missing required mailbox configuration: ${missing.join(", ")}`);
	}

	const token = await graphToken(config);
	const messages = await listGraphUnreadMessages(config, token);
	let processed = 0;
	let succeeded = 0;
	let failed = 0;

	if (!messages.length) {
		console.log("[ota-mailbox] no unread graph messages");
		return { processed, succeeded, failed };
	}

	for (const message of messages) {
		processed += 1;
		console.log("[ota-mailbox] forwarding graph message", {
			id: String(message.id || "").slice(0, 12),
			subject: message.subject || "",
			from: message.from?.emailAddress?.address || "",
			messageId: message.internetMessageId || "",
		});

		try {
			const source = await graphMessageRaw(config, token, message.id);
			const result = await postInboundEmail(config, source);
			if (!result.ok) {
				failed += 1;
				console.error("[ota-mailbox] inbound post failed", {
					id: String(message.id || "").slice(0, 12),
					status: result.status,
					body: String(result.body || "").slice(0, 500),
				});
				continue;
			}

			succeeded += 1;
			if (config.markSeenAfterSuccess && !config.dryRun) {
				await markGraphMessageRead(config, token, message.id);
			}
		} catch (error) {
			failed += 1;
			console.error("[ota-mailbox] graph message failed", {
				id: String(message.id || "").slice(0, 12),
				error: describeError(error),
			});
		}
	}

	return { processed, succeeded, failed };
};

const processImapMailbox = async (config) => {
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
					error: describeError(error),
				});
			}
		}
	} finally {
		lock.release();
		await client.logout().catch(() => {});
	}

	return { processed, succeeded, failed };
};

const processMailbox = async (config) =>
	config.provider === "graph"
		? processGraphMailbox(config)
		: processImapMailbox(config);

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

	if (process.argv.includes("--test-connection")) {
		try {
			const result = await testConnection(config);
			console.log("[ota-mailbox] connection", result);
			process.exit(0);
		} catch (error) {
			console.error("[ota-mailbox] connection failed", describeError(error));
			process.exit(1);
		}
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
			console.error("[ota-mailbox] poll failed", describeError(error));
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
		console.error("[ota-mailbox] fatal", describeError(error));
		process.exit(1);
	});
}

module.exports = {
	getConfig,
	validateConfig,
	testConnection,
	processMailbox,
	postInboundEmail,
};
