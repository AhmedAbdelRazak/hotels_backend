/** @format */

const sgMail = require("@sendgrid/mail");
const {
	normalizeWhitespace,
	redactSensitive,
	safeSnippet,
} = require("./otaReservationMapper");
const {
	classifyOtaGuestCommunication,
} = require("./otaInboundCommunicationClassifier");

const DEFAULT_FORWARD_TO = "ahmed.abdelrazak@jannatbooking.com";
const DEFAULT_FORWARD_FROM = "noreply@jannatbooking.com";

const STATUS_FORWARD_REASONS = new Set(["needs_review", "needs_mapping", "failed"]);

const DECISION_RULES = [
	{
		category: "verification",
		reason: "verification_email",
		pattern:
			/\b(verify|verification|confirm your email|email confirmation|activate your account|activation link|validate email|confirm email address)\b/i,
	},
	{
		category: "one_time_code",
		reason: "one_time_code",
		pattern:
			/\b(otp|one[-\s]?time code|one[-\s]?time password|verification code|security code|login code|authentication code|2fa|two[-\s]?factor|multi[-\s]?factor)\b/i,
	},
	{
		category: "account_security",
		reason: "account_security",
		pattern:
			/\b(password reset|reset your password|new sign[-\s]?in|new login|unusual activity|suspicious|security alert|account locked|account suspended|account access|sign[-\s]?in attempt)\b/i,
	},
	{
		category: "ota_action_required",
		reason: "ota_action_required",
		pattern:
			/\b(action required|required action|response required|respond within|reply required|deadline|missing information|complete setup|property verification|listing verification|partner verification)\b/i,
	},
	{
		category: "ota_finance_or_dispute",
		reason: "ota_finance_or_dispute",
		pattern:
			/\b(chargeback|dispute|invoice|payout|payment issue|payment failed|virtual card|vcc|tax form|bank account|finance verification)\b/i,
	},
];

const splitRecipients = (value = "") =>
	String(value || "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);

const getForwardRecipients = () => {
	const configured = splitRecipients(
		process.env.OTA_INBOUND_FORWARD_TO ||
			process.env.OTA_SECURITY_FORWARD_TO ||
			""
	);
	return configured.length ? configured : [DEFAULT_FORWARD_TO];
};

const getForwardFrom = () =>
	String(process.env.OTA_INBOUND_FORWARD_FROM || DEFAULT_FORWARD_FROM).trim() ||
	DEFAULT_FORWARD_FROM;

const isForwardingDisabled = () =>
	["0", "false", "off", "disabled", "no"].includes(
		String(process.env.OTA_INBOUND_FORWARD_ENABLED || "true").toLowerCase()
	);

const isDryRun = () =>
	["1", "true", "yes", "dry-run", "dryrun"].includes(
		String(process.env.OTA_INBOUND_FORWARD_DRY_RUN || "").toLowerCase()
	);

const stripTrailingUrlPunctuation = (value = "") =>
	String(value || "").replace(/[)\].,;:!?'"<>]+$/g, "");

const extractLinks = (text = "") => {
	const matches = String(text || "").match(/https?:\/\/[^\s<>"']+/gi) || [];
	return Array.from(new Set(matches.map(stripTrailingUrlPunctuation).filter(Boolean))).slice(
		0,
		20
	);
};

const escapeHtml = (value = "") =>
	String(value || "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");

const buildDecisionText = ({ email = {}, normalized = {} } = {}) =>
	normalizeWhitespace(
		[
			email.from,
			email.to,
			email.cc,
			email.subject,
			email.text,
			email.html,
			normalized.provider,
			normalized.providerLabel,
			normalized.bookingSource,
		]
			.filter(Boolean)
			.join("\n")
	);

const statusReason = (status = "") => {
	const value = String(status || "").toLowerCase();
	if (!STATUS_FORWARD_REASONS.has(value)) return "";
	return `ota_inbound_${value}`;
};

const providerLooksOta = (normalized = {}, email = {}) => {
	const provider = String(normalized.provider || "").toLowerCase();
	if (provider && provider !== "unknown") return true;
	const text = buildDecisionText({ email, normalized }).toLowerCase();
	return /\b(expedia|agoda|booking\.com|hotels\.com|hotelrunner|trip\.com|airbnb|ycs|partner central|extranet)\b/i.test(
		text
	);
};

const buildImportantEmailForwardDecision = ({
	email = {},
	normalized = {},
	reconciliation = {},
} = {}) => {
	const status = String(reconciliation.status || "").toLowerCase();
	const sourceText = buildDecisionText({ email, normalized });
	const redactedText = redactSensitive(sourceText);
	const communication = classifyOtaGuestCommunication(email, {
		provider: normalized.provider,
		providerLabel: normalized.providerLabel,
		originalFrom: normalized.originalFrom,
		originalSubject: normalized.originalSubject,
		fromCandidates: normalized.fromCandidates,
		subjectCandidates: normalized.subjectCandidates,
		emailText: sourceText,
	});
	const explicitSuppression =
		normalized.suppressForwarding === true ||
		normalized.communicationClassification?.suppressForwarding === true;

	// A deterministic communication classification always wins over alert
	// keywords and processing statuses. These emails are intentionally silent.
	if (communication.suppressForwarding || explicitSuppression) {
		const links = extractLinks(redactedText);
		const suppressionReason =
			communication.reason ||
			normalized.communicationClassification?.reason ||
			"guest_communication";
		return {
			shouldForward: false,
			reason: suppressionReason,
			categories: [],
			matchedTerms: [],
			linkCount: links.length,
			links,
			status,
			suppressed: true,
			suppressionReason,
			communicationProvider: communication.provider || normalized.provider || "",
		};
	}
	const categories = [];
	const matchedTerms = [];

	for (const rule of DECISION_RULES) {
		const match = redactedText.match(rule.pattern);
		if (match) {
			categories.push(rule.category);
			matchedTerms.push(match[0]);
		}
	}

	const links = extractLinks(redactedText);
	const statusForwardReason = statusReason(status);
	const shouldForwardByStatus =
		!!statusForwardReason && providerLooksOta(normalized, email);
	const shouldForward = categories.length > 0 || shouldForwardByStatus;
	const reason = categories.length
		? DECISION_RULES.find((rule) => rule.category === categories[0])?.reason ||
			categories[0]
		: statusForwardReason;

	return {
		shouldForward,
		reason: reason || "",
		categories,
		matchedTerms: Array.from(new Set(matchedTerms)).slice(0, 10),
		linkCount: links.length,
		links,
		status,
	};
};

const buildForwardSubject = ({ email = {}, decision = {}, reconciliation = {} } = {}) => {
	const label = decision.categories?.[0] || decision.reason || "attention";
	const status = reconciliation.status ? `/${reconciliation.status}` : "";
	const originalSubject = normalizeWhitespace(email.subject || "No subject").slice(0, 120);
	return `[OTA Inbound ${label}${status}] ${originalSubject}`;
};

const buildForwardBody = ({
	email = {},
	inboundRecord = {},
	normalized = {},
	reconciliation = {},
	decision = {},
} = {}) => {
	const bodyText = redactSensitive(
		normalizeWhitespace(`${email.subject || ""}\n${email.text || ""}`)
	);
	const links = decision.links || [];
	const lines = [
		"An inbound OTA email needs human attention.",
		"",
		`Reason: ${decision.reason || "important_email"}`,
		`Categories: ${(decision.categories || []).join(", ") || "none"}`,
		`Inbound audit ID: ${inboundRecord?._id || ""}`,
		`Processing status: ${reconciliation.status || ""}`,
		`Provider: ${normalized.providerLabel || normalized.provider || ""}`,
		`Intent/event: ${normalized.intent || ""} / ${normalized.eventType || ""}`,
		`OTA confirmation: ${normalized.confirmationNumber || ""}`,
		`PMS confirmation: ${reconciliation.pmsConfirmationNumber || ""}`,
		`Hotel: ${normalized.hotelName || ""}`,
		`From: ${email.from || ""}`,
		`To: ${email.to || ""}`,
		`Subject: ${email.subject || ""}`,
		"",
		links.length ? "Links found:" : "Links found: none",
		...links.map((link) => `- ${link}`),
		"",
		"Redacted email text:",
		safeSnippet(bodyText, 6000),
	];

	const html = `
		<div style="font-family:Arial,sans-serif;line-height:1.45;color:#1f2937">
			<h2>Inbound OTA email needs human attention</h2>
			<p><strong>Reason:</strong> ${escapeHtml(decision.reason || "important_email")}</p>
			<p><strong>Categories:</strong> ${escapeHtml((decision.categories || []).join(", ") || "none")}</p>
			<table cellpadding="6" cellspacing="0" style="border-collapse:collapse;border:1px solid #d1d5db">
				<tr><td><strong>Inbound audit ID</strong></td><td>${escapeHtml(inboundRecord?._id || "")}</td></tr>
				<tr><td><strong>Processing status</strong></td><td>${escapeHtml(reconciliation.status || "")}</td></tr>
				<tr><td><strong>Provider</strong></td><td>${escapeHtml(normalized.providerLabel || normalized.provider || "")}</td></tr>
				<tr><td><strong>Intent/event</strong></td><td>${escapeHtml(`${normalized.intent || ""} / ${normalized.eventType || ""}`)}</td></tr>
				<tr><td><strong>OTA confirmation</strong></td><td>${escapeHtml(normalized.confirmationNumber || "")}</td></tr>
				<tr><td><strong>PMS confirmation</strong></td><td>${escapeHtml(reconciliation.pmsConfirmationNumber || "")}</td></tr>
				<tr><td><strong>Hotel</strong></td><td>${escapeHtml(normalized.hotelName || "")}</td></tr>
				<tr><td><strong>From</strong></td><td>${escapeHtml(email.from || "")}</td></tr>
				<tr><td><strong>To</strong></td><td>${escapeHtml(email.to || "")}</td></tr>
				<tr><td><strong>Subject</strong></td><td>${escapeHtml(email.subject || "")}</td></tr>
			</table>
			<h3>Links found</h3>
			${
				links.length
					? `<ul>${links
							.map(
								(link) =>
									`<li><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></li>`
							)
							.join("")}</ul>`
					: "<p>None</p>"
			}
			<h3>Redacted email text</h3>
			<pre style="white-space:pre-wrap;background:#f9fafb;border:1px solid #e5e7eb;padding:12px">${escapeHtml(
				safeSnippet(bodyText, 6000)
			)}</pre>
		</div>
	`;

	return { text: lines.join("\n"), html };
};

const forwardImportantInboundEmail = async ({
	email = {},
	inboundRecord = {},
	normalized = {},
	reconciliation = {},
} = {}) => {
	const decision = buildImportantEmailForwardDecision({
		email,
		normalized,
		reconciliation,
	});

	if (!decision.shouldForward) {
		return {
			decision,
			forwarding: {
				status: "not_required",
				attemptedAt: null,
				forwardedAt: null,
				forwardedTo: [],
				error: "",
			},
		};
	}

	const recipients = getForwardRecipients();
	const forwarding = {
		status: "pending",
		provider: "sendgrid",
		forwardedTo: recipients,
		attemptedAt: new Date(),
		forwardedAt: null,
		error: "",
	};

	if (isForwardingDisabled()) {
		return {
			decision,
			forwarding: {
				...forwarding,
				status: "disabled",
				error: "OTA inbound forwarding is disabled by OTA_INBOUND_FORWARD_ENABLED.",
			},
		};
	}

	if (isDryRun()) {
		return {
			decision,
			forwarding: {
				...forwarding,
				status: "dry_run",
			},
		};
	}

	if (!process.env.SENDGRID_API_KEY) {
		return {
			decision,
			forwarding: {
				...forwarding,
				status: "skipped",
				error: "SENDGRID_API_KEY is not configured.",
			},
		};
	}

	sgMail.setApiKey(process.env.SENDGRID_API_KEY);
	const body = buildForwardBody({
		email,
		inboundRecord,
		normalized,
		reconciliation,
		decision,
	});

	try {
		const [response] = await sgMail.send({
			to: recipients,
			from: getForwardFrom(),
			subject: buildForwardSubject({ email, decision, reconciliation }),
			text: body.text,
			html: body.html,
		});
		return {
			decision,
			forwarding: {
				...forwarding,
				status: "sent",
				forwardedAt: new Date(),
				messageId: response?.headers?.["x-message-id"] || "",
			},
		};
	} catch (error) {
		return {
			decision,
			forwarding: {
				...forwarding,
				status: "failed",
				error: error?.message || "Failed to forward inbound email.",
			},
		};
	}
};

module.exports = {
	buildImportantEmailForwardDecision,
	forwardImportantInboundEmail,
};
