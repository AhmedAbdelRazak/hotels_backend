/** @format */

const nodemailer = require("nodemailer");

const DEFAULT_FROM = "Jannat Booking <noreply@jannatbooking.com>";
const DEFAULT_ALLOWED_FROM_DOMAINS = ["jannatbooking.com"];

let cachedTransporter = null;
let cachedSignature = "";

const normalizeWhitespace = (value = "") =>
	String(value || "").replace(/\s+/g, " ").trim();

const splitList = (value = "") =>
	String(value || "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);

const boolFromEnv = (name, defaultValue = false) => {
	const raw = process.env[name];
	if (raw === undefined || raw === null || raw === "") return defaultValue;
	return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
};

const numberFromEnv = (name, defaultValue) => {
	const parsed = Number(process.env[name]);
	return Number.isFinite(parsed) ? parsed : defaultValue;
};

const getDefaultFrom = () =>
	normalizeWhitespace(
		process.env.MAIL_FROM ||
			process.env.EMAIL_FROM ||
			process.env.SMTP_FROM ||
			process.env.SMTP_USER ||
			DEFAULT_FROM
	);

const addressText = (value) => {
	if (!value) return "";
	if (typeof value === "string") return normalizeWhitespace(value);
	if (typeof value === "object") {
		const email = normalizeWhitespace(value.email || value.address || value.mail || "");
		const name = normalizeWhitespace(value.name || value.displayName || "");
		if (!email) return "";
		return name ? { name, address: email } : email;
	}
	return normalizeWhitespace(value);
};

const normalizeAddressList = (value) => {
	const flatten = (input) => {
		if (!input) return [];
		if (Array.isArray(input)) return input.flatMap(flatten);
		if (typeof input === "string" && input.includes(",")) {
			return splitList(input);
		}
		const item = addressText(input);
		return item ? [item] : [];
	};
	const result = flatten(value);
	if (!result.length) return undefined;
	return result.length === 1 ? result[0] : result;
};

const parseEmailDomain = (address = "") => {
	const text =
		typeof address === "object"
			? address.address || address.email || ""
			: String(address || "");
	const match = text.match(/@([a-z0-9.-]+)>?$/i) || text.match(/<[^@<>]+@([a-z0-9.-]+)>/i);
	return match ? match[1].toLowerCase() : "";
};

const allowedFromDomains = () => {
	const configured = splitList(process.env.MAIL_ALLOWED_FROM_DOMAINS);
	return configured.length ? configured.map((item) => item.toLowerCase()) : DEFAULT_ALLOWED_FROM_DOMAINS;
};

const normalizeFrom = (from) => {
	const requested = normalizeAddressList(from) || getDefaultFrom();
	if (boolFromEnv("MAIL_ALLOW_ANY_FROM", false)) return requested;

	const domain = parseEmailDomain(requested);
	if (!domain || allowedFromDomains().includes(domain)) return requested;

	return getDefaultFrom();
};

const uniqueAddresses = (addresses = []) => {
	const seen = new Set();
	const result = [];
	addresses.filter(Boolean).forEach((item) => {
		const normalized = typeof item === "object" ? item.address || item.email || JSON.stringify(item) : String(item);
		const key = normalized.toLowerCase();
		if (!key || seen.has(key)) return;
		seen.add(key);
		result.push(item);
	});
	return result;
};

const appendConfiguredRecipients = (base, envNames) => {
	const values = envNames.flatMap((name) => splitList(process.env[name]));
	if (!values.length) return base;
	const current = normalizeAddressList(base);
	const currentList = Array.isArray(current) ? current : current ? [current] : [];
	return uniqueAddresses([...currentList, ...values]);
};

const normalizeAttachment = (attachment = {}) => {
	if (!attachment || typeof attachment !== "object") return attachment;
	const normalized = {
		filename: attachment.filename || attachment.name || "attachment",
		contentType: attachment.type || attachment.contentType,
		contentDisposition: attachment.disposition,
		cid: attachment.contentId || attachment.cid,
	};
	if (attachment.path) normalized.path = attachment.path;
	else if (attachment.href) normalized.href = attachment.href;
	else if (Buffer.isBuffer(attachment.content)) normalized.content = attachment.content;
	else if (attachment.encoding === "base64" || attachment.disposition || attachment.type) {
		normalized.content = Buffer.from(String(attachment.content || ""), "base64");
	} else if (attachment.content !== undefined) {
		normalized.content = attachment.content;
	}
	return normalized;
};

const smtpConfig = () => {
	const dryRun = boolFromEnv("EMAIL_DRY_RUN", false);
	if (dryRun) {
		return {
			signature: "dry-run",
			transport: {
				streamTransport: true,
				buffer: true,
				newline: "unix",
			},
		};
	}

	const url = process.env.SMTP_URL || process.env.MAIL_SMTP_URL || process.env.EMAIL_SMTP_URL;
	if (url) {
		return {
			signature: `url:${url}`,
			transport: url,
		};
	}

	const host = process.env.SMTP_HOST || process.env.MAIL_HOST || process.env.EMAIL_HOST;
	if (!host) {
		const error = new Error(
			"SMTP is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, and MAIL_FROM."
		);
		error.code = "SMTP_NOT_CONFIGURED";
		throw error;
	}

	const port = numberFromEnv("SMTP_PORT", numberFromEnv("MAIL_PORT", 587));
	const secure = boolFromEnv("SMTP_SECURE", port === 465);
	const user = process.env.SMTP_USER || process.env.MAIL_USER || process.env.EMAIL_USER;
	const pass = process.env.SMTP_PASS || process.env.MAIL_PASS || process.env.EMAIL_PASS;
	const auth = user && pass ? { user, pass } : undefined;

	const transport = {
		host,
		port,
		secure,
		auth,
		requireTLS: secure ? false : boolFromEnv("SMTP_REQUIRE_TLS", true),
		connectionTimeout: numberFromEnv("SMTP_CONNECTION_TIMEOUT_MS", 15000),
		greetingTimeout: numberFromEnv("SMTP_GREETING_TIMEOUT_MS", 15000),
		socketTimeout: numberFromEnv("SMTP_SOCKET_TIMEOUT_MS", 30000),
		tls: {
			minVersion: process.env.SMTP_TLS_MIN_VERSION || "TLSv1.2",
			rejectUnauthorized: boolFromEnv("SMTP_TLS_REJECT_UNAUTHORIZED", true),
			servername: process.env.SMTP_TLS_SERVERNAME || host,
		},
	};

	return {
		signature: JSON.stringify({
			host,
			port,
			secure,
			user: user ? "***" : "",
			from: getDefaultFrom(),
		}),
		transport,
	};
};

const getTransporter = () => {
	const config = smtpConfig();
	if (!cachedTransporter || cachedSignature !== config.signature) {
		cachedTransporter = nodemailer.createTransport(config.transport);
		cachedSignature = config.signature;
	}
	return cachedTransporter;
};

const toMailOptions = (message = {}) => {
	const from = normalizeFrom(message.from);
	const requestedFrom = normalizeAddressList(message.from);
	const replyTo = normalizeAddressList(message.replyTo || message.reply_to);
	const forcedFrom = requestedFrom && JSON.stringify(requestedFrom) !== JSON.stringify(from);

	return {
		from,
		to: normalizeAddressList(message.to),
		cc: normalizeAddressList(
			appendConfiguredRecipients(message.cc, ["MAIL_ALWAYS_CC", "EMAIL_ALWAYS_CC"])
		),
		bcc: normalizeAddressList(
			appendConfiguredRecipients(message.bcc, [
				"MAIL_ALWAYS_BCC",
				"EMAIL_ALWAYS_BCC",
				"MAIL_AUDIT_BCC",
			])
		),
		replyTo: replyTo || (forcedFrom ? requestedFrom : undefined),
		subject: message.subject || "",
		text: message.text,
		html: message.html,
		attachments: Array.isArray(message.attachments)
			? message.attachments.map(normalizeAttachment)
			: undefined,
		headers: message.headers,
	};
};

const send = async (message = {}) => {
	const mailOptions = toMailOptions(message);
	if (!mailOptions.to && !mailOptions.cc && !mailOptions.bcc) {
		const error = new Error("Email recipient is required.");
		error.code = "EMAIL_RECIPIENT_REQUIRED";
		throw error;
	}
	const info = await getTransporter().sendMail(mailOptions);
	return [
		{
			statusCode: 202,
			headers: { "x-message-id": info.messageId || "" },
			messageId: info.messageId || "",
			accepted: info.accepted || [],
			rejected: info.rejected || [],
			response: info.response || "",
			envelope: info.envelope || {},
		},
	];
};

const verify = async () => {
	const config = smtpConfig();
	if (config.signature === "dry-run") return true;
	return getTransporter().verify();
};

const getDiagnostics = () => {
	try {
		const config = smtpConfig();
		if (config.signature === "dry-run") return { configured: true, mode: "dry-run" };
		if (typeof config.transport === "string") return { configured: true, mode: "smtp-url" };
		return {
			configured: true,
			mode: "smtp",
			host: config.transport.host,
			port: config.transport.port,
			secure: config.transport.secure,
			requireTLS: config.transport.requireTLS,
			from: getDefaultFrom(),
			allowedFromDomains: allowedFromDomains(),
		};
	} catch (error) {
		return { configured: false, error: error.code || error.message };
	}
};

module.exports = {
	send,
	verify,
	getDiagnostics,
	toMailOptions,
	normalizeAddressList,
};
