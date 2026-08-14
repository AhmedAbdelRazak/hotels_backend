/** @format */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
	MAX_RECONCILIATION_ATTACHMENT_BYTES,
	ReconciliationAttachmentError,
	detectAttachmentMimeType,
	sanitizeAttachmentName,
	validateReconciliationAttachment,
} = require("./reconciliationAttachment");

const signatures = {
	"application/pdf": Buffer.from("%PDF-1.7\nfixture"),
	"image/jpeg": Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]),
	"image/png": Buffer.from([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
	]),
	"image/webp": Buffer.from([
		0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42,
		0x50,
	]),
};

test("attachment detection and validation accept only the four genuine formats", () => {
	for (const [mimeType, buffer] of Object.entries(signatures)) {
		assert.equal(detectAttachmentMimeType(buffer), mimeType);
		const validated = validateReconciliationAttachment({
			buffer,
			mimetype: mimeType,
			originalname: "proof<>.bin",
		});
		assert.equal(validated.mimeType, mimeType);
		assert.equal(validated.bytes, buffer.length);
		assert.equal(validated.originalName, "proof.bin");
	}
});

test("attachment validation rejects spoofed MIME types, SVG, executables, and empty files", () => {
	for (const file of [
		{ buffer: signatures["application/pdf"], mimetype: "image/png" },
		{ buffer: Buffer.from("<svg></svg>"), mimetype: "image/svg+xml" },
		{ buffer: Buffer.from("MZ executable"), mimetype: "application/pdf" },
		{ buffer: Buffer.alloc(0), mimetype: "application/pdf" },
	]) {
		assert.throws(
			() => validateReconciliationAttachment(file),
			(error) => error instanceof ReconciliationAttachmentError
		);
	}
});

test("attachment validation uses actual bytes and enforces the 10MB ceiling", () => {
	const oversized = Buffer.alloc(MAX_RECONCILIATION_ATTACHMENT_BYTES + 1);
	signatures["application/pdf"].copy(oversized);
	assert.throws(
		() =>
			validateReconciliationAttachment({
				buffer: oversized,
				mimetype: "application/pdf",
				originalname: "large.pdf",
			}),
		(error) =>
			error instanceof ReconciliationAttachmentError &&
			error.code === "reconciliation_attachment_too_large" &&
			error.statusCode === 413
	);
});

test("attachment names are bounded and stripped of path/control characters", () => {
	const sanitized = sanitizeAttachmentName(
		`../bad\\name\x00\u202E${"x".repeat(300)}.pdf`
	);
	assert.equal(sanitized.length, 160);
	assert.doesNotMatch(sanitized, /[<>:"/\\|?*\x00-\x1f]/);
	assert.doesNotMatch(sanitized, /[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069]/);
});
