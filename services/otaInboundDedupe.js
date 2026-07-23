/** @format */

const crypto = require("crypto");

const INBOUND_CLAIM_LEASE_MS = 30 * 60 * 1000;

const sha256 = (value = "") =>
	crypto.createHash("sha256").update(String(value || "")).digest("hex");

const normalizeUnicode = (value = "") =>
	String(value || "")
		.normalize("NFKC")
		.replace(/[\u200B-\u200D\u2060\uFEFF]/g, "");

const normalizeMessageId = (value = "") => {
	let normalized = normalizeUnicode(value)
		.trim()
		.replace(/^message-id\s*:/i, "")
		.trim();
	while (/^<.*>$/.test(normalized)) {
		normalized = normalized.slice(1, -1).trim();
	}
	return normalized.replace(/\s+/g, "").toLowerCase();
};

const decodeHtmlEntities = (value = "") =>
	String(value || "")
		.replace(/&nbsp;|&#160;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#(?:39|x27);/gi, "'")
		.replace(/&#(\d+);/g, (_match, decimal) => {
			const codePoint = Number(decimal);
			return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
				? String.fromCodePoint(codePoint)
				: " ";
		})
		.replace(/&#x([0-9a-f]+);/gi, (_match, hexadecimal) => {
			const codePoint = Number.parseInt(hexadecimal, 16);
			return Number.isInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
				? String.fromCodePoint(codePoint)
				: " ";
		});

const htmlToCanonicalText = (html = "") =>
	decodeHtmlEntities(html)
		.replace(/<style\b[\s\S]*?<\/style>/gi, " ")
		.replace(/<script\b[\s\S]*?<\/script>/gi, " ")
		.replace(/<\/?(?:br|p|div|tr|table|thead|tbody|li|ul|ol|h\d)\b[^>]*>/gi, "\n")
		.replace(/<\/?(?:td|th)\b[^>]*>/gi, " ")
		.replace(/<[^>]+>/g, " ");

const normalizeRedactionMarkers = (value = "") =>
	String(value || "")
		.replace(/\[(?:card[-\s]*\d{0,4}|redacted(?:\s+[^\]]*)?)\]/gi, "[redacted]")
		.replace(
			/\b(card\s*(?:number|no\.?|#)|pan)\s*[:#-]?\s*(?:\[redacted\]|(?:\d[\s-]*){12,19}|(?:[x*\u2022][x*\u2022\s-]*){3,}\d{0,4})/gi,
			"$1 [redacted]"
		)
		.replace(
			/\b(cvv|cvc|validation\s+code|security\s+code)\s*[:#-]?\s*(?:\[redacted\]|\d{3,4}|(?:[x*\u2022][x*\u2022\s-]*){3,4})/gi,
			"$1 [redacted]"
		);

const canonicalizeText = (value = "") =>
	normalizeRedactionMarkers(normalizeUnicode(value))
		.replace(/=\r?\n/g, "")
		.replace(/\r\n?/g, "\n")
		.replace(/[\t\n\f\v\u00A0 ]+/g, " ")
		.trim()
		.toLowerCase();

const canonicalizeAddressList = (value = "") => {
	const normalized = normalizeUnicode(value).toLowerCase();
	const addresses = normalized.match(
		/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?/gi
	);
	if (!addresses?.length) return canonicalizeText(normalized);
	return [...new Set(addresses.map((address) => address.toLowerCase()))]
		.sort()
		.join(",");
};

const canonicalizeAttachments = (attachments = []) =>
	(Array.isArray(attachments) ? attachments : [])
		.map((attachment = {}) =>
			[
				canonicalizeText(attachment.filename || attachment.name || ""),
				canonicalizeText(attachment.contentType || attachment.mimetype || ""),
				canonicalizeText(attachment.contentId || ""),
				canonicalizeText(attachment.contentHash || ""),
				Number(attachment.size || attachment.content?.length || 0) || 0,
			].join(":")
		)
		.filter(Boolean)
		.sort()
		.join("|");

const canonicalizeInboundEmailContent = (email = {}) => {
	const textBody = String(email.text || "").trim();
	const canonicalBody = canonicalizeText(
		textBody || htmlToCanonicalText(email.html || "")
	);
	return [
		`from:${canonicalizeAddressList(email.from || "")}`,
		`to:${canonicalizeAddressList(email.to || "")}`,
		`cc:${canonicalizeAddressList(email.cc || "")}`,
		`bcc:${canonicalizeAddressList(email.bcc || "")}`,
		`subject:${canonicalizeText(email.subject || "")}`,
		`body:${canonicalBody}`,
		`attachments:${canonicalizeAttachments(email.attachments)}`,
	].join("\n");
};

const hasDedupeContent = (email = {}) =>
	Boolean(
		normalizeMessageId(email.messageId) ||
		canonicalizeAddressList(email.from || "") ||
		canonicalizeText(email.subject || "") ||
		canonicalizeText(email.text || htmlToCanonicalText(email.html || "")) ||
		(Array.isArray(email.attachments) && email.attachments.length)
	);

const buildInboundDedupeKey = (email = {}) => {
	const messageId = normalizeMessageId(email.messageId);
	if (messageId) return `mid:${sha256(messageId)}`;
	if (!hasDedupeContent(email)) return "";
	return `content:${sha256(canonicalizeInboundEmailContent(email))}`;
};

const isReclaimableInboundClaim = (
	record = {},
	{ now = Date.now(), leaseMs = INBOUND_CLAIM_LEASE_MS } = {},
) => {
	const status = String(record.processingStatus || "").trim().toLowerCase();
	if (status === "failed") return true;
	if (status !== "received") return false;
	const receivedAt = new Date(record.receivedAt || 0).getTime();
	return (
		Number.isFinite(receivedAt) &&
		receivedAt > 0 &&
		receivedAt <= Number(now) - Number(leaseMs)
	);
};

const shouldRetryInboundCollision = (record = {}, duplicateSource = "") =>
	duplicateSource === "atomic_claim" &&
	String(record.processingStatus || "").trim().toLowerCase() === "received";

module.exports = {
	INBOUND_CLAIM_LEASE_MS,
	buildInboundDedupeKey,
	canonicalizeInboundEmailContent,
	isReclaimableInboundClaim,
	normalizeMessageId,
	shouldRetryInboundCollision,
};
